# Hide CTBid Items — Implementation Plan

Source of truth: `SPEC.md`. This plan resolves the spec's ambiguities and fixes the code shape before any file is written. Where this plan and the spec disagree, the spec wins unless the plan states an explicit assumption below.

## 1. Goal and non-goals

**Goal.** Replace the `hide.js` placeholder with a working Firefox MV3 extension. On item grid pages (sale `/estate-sale/<id>`, category `/category/...`, search `/view-more-items/<term>`), each item card gets a 48x48 X button. Clicking it hides the card through a generated stylesheet, so the grid reflows with no gap and the hide survives framework re-renders. Hidden state lives in `browser.storage.local` as one key per item, expires after 14 days, and is pruned on every content-script load. It syncs live across tabs through `storage.onChanged`. Item detail pages show a banner with Unhide when the item is hidden. A toolbar popup lists hidden items with days left, Unhide, and a two-click Clear all. Deliverables: `manifest.json` (rewritten), `common.js`, `content.js`, `content.css`, `popup/popup.{html,js,css}`, `hide.js` deleted, `CLAUDE.md` updated.

**Non-goals.** No background script, alarms, or expiry while a tab stays open. No buttons or hiding on watchlist, sale list, location, home, or account pages. No Firefox for Android or Chrome support, and no polyfill. No backfilling short pages, no rewriting item counts or pagination, no in-page undo toast. No options page, sync storage, import/export, or per-sale views in the popup. No build step, bundler, or linter. npm is used only for the Vitest + happy-dom test suite (added after the initial plan); the manual checklist in `SPEC.md` still covers real-browser behavior. No hiding by node manipulation (`style.display` on cards, removing nodes). No refactoring beyond the files listed above.

## 2. Design decisions

### 2.1 Shared module: `common.js`

Loaded first by the content script entry and by `popup.html` with a `<script>` tag. Both are classic scripts, so one top-level `const` is visible to the next script in the same context. Everything lives on one frozen object to avoid leaking many globals into the content-script sandbox.

```js
// common.js
const CTHIDE = Object.freeze({
  DAY_MS: 24 * 60 * 60 * 1000,
  TTL_MS: 10 * 24 * 60 * 60 * 1000,           // 864,000,000
  KEY_PREFIX: "hidden:",
  TITLE_MAX: 200,
  PENDING_FAILSAFE_MS: 2000,

  SEL: Object.freeze({
    card:  ".listitem",
    host:  ".listitem > .itemcard",
    link:  "a.image-container[href]",
    title: ".itemcard-head",
    img:   "img.items-image",
  }),

  RE: Object.freeze({
    itemHref:   /\/estate-sale\/(\d+)\/item\/(\d+)/,       // 1 = saleId, 2 = itemId
    gridPath:   /^\/(?:estate-sale\/\d+|category(?:\/[^/]+){1,2}|category_list\/[^/]+|view-more-items\/[^/]+)\/?$/,
    detailPath: /^\/(?:estate-sale|view-more-items)\/(\d+)\/item\/(\d+)(\/|$)/,
    itemId:     /^\d+$/,
  }),

  /** @returns {"grid"|"detail"|"none"} */
  modeFor(pathname) {},

  /** "5684472" -> "hidden:5684472" */
  keyFor(itemId) {},

  /** "hidden:5684472" -> "5684472"; null if not our key or ID not all digits */
  itemIdFromKey(key) {},

  /** Returns a normalized Entry, or null if malformed (missing/non-finite hiddenAt). */
  parseEntry(value) {},

  /** True when now >= hiddenAt + TTL_MS. Malformed => true. */
  isExpired(entry, now = Date.now()) {},

  /** floor((now - hiddenAt) / DAY_MS), min 0 */
  daysAgo(entry, now = Date.now()) {},

  /** ceil((hiddenAt + TTL_MS - now) / DAY_MS), min 0 */
  daysLeft(entry, now = Date.now()) {},

  /** "1 day" / "3 days" */
  plural(n, word) {},

  /**
   * Splits a storage.local.get(null) result.
   * @returns {{ live: Map<string, Entry>, deadKeys: string[] }}
   */
  partition(all, now = Date.now()) {},
});
```

Entry schema (storage value, unchanged from spec):

```ts
type Entry = {
  hiddenAt: number;   // epoch ms
  saleId:   string;
  title:    string;   // <= 200 chars
  url:      string;   // absolute
};
```

Decisions:
- **`partition()` in common.js.** Content script and popup both need "read all, drop expired". One helper keeps the expiry rule in one place. The content script also removes `deadKeys`; the popup ignores them, because the spec says the popup does not prune.
- **`itemIdFromKey` validates `^\d+$`.** The ID is interpolated into a CSS selector. A non-digit ID from a tampered or corrupt key is treated as malformed and pruned. This removes any CSS-injection path. Alternative considered: `CSS.escape()`. Rejected, because IDs are digits by definition and rejecting is simpler than escaping.
- **Frozen namespace object, not ES modules.** Content scripts declared in the manifest cannot be ES modules without a dynamic `import()` workaround. Alternative considered: separate globals per constant. Rejected, because it spreads names across the sandbox.

### 2.2 Content script: `content.js`

Module-level state:

```js
let currentMode = "none";               // "grid" | "detail" | "none"
const hidden = new Map();               // Map<itemId: string, Entry>
let styleEl = null;                     // <style id="cthide-rules">
let bannerEl = null;                    // <div id="cthide-banner">
let bannerDismissedFor = null;          // itemId dismissed on this page view
let scanQueued = false;
```

Functions:

```js
async function init()                   // entry point
function checkMode()                    // recompute mode from location.pathname, apply side effects
function renderRules()                  // rebuild styleEl.textContent from `hidden`; re-append styleEl if detached
function ruleFor(itemId) -> string      // one CSS rule for one item
function queueScan()                    // rAF-batched; called by MutationObserver
function scan()                         // checkMode(), ensure styleEl attached, then grid: addButtons(); detail: renderBanner()
function addButtons()                   // add a button to each .listitem > .itemcard lacking one
function makeButton(itemId) -> HTMLButtonElement
function onButtonEvent(e)               // window capture: swallow; primary click, no modifiers => hideFromCard()
async function hideFromCard(btn, itemId)
function readCardInfo(card, itemId) -> { saleId, title, url }
function focusNextButton(card)
function onStorageChanged(changes, area)
function renderBanner()                 // detail mode: show/update/remove
function removeBanner()
```

Startup sequence (`init`):
1. If `CTHIDE.modeFor(location.pathname) === "grid"`, add `cthide-pending` to `document.documentElement`.
2. Create `styleEl` and append it to `document.documentElement`.
3. Register `storage.onChanged` before the read, so a change made during the read is not lost. While the read is in flight, `onChanged` applies changes to the Map and records each item ID in `touchedDuringLoad`. The read result then skips those IDs, so a hide or unhide that arrived during the read wins over the possibly stale read.
4. `try`: `get(null)` → `partition()` → fill `hidden` → `renderRules()` → `remove(deadKeys)` if any, not awaited, errors logged. `finally`: remove `cthide-pending`.
   Failsafe: a 2000 ms `setTimeout` (`PENDING_FAILSAFE_MS`) also removes `cthide-pending`, so a storage read that never settles cannot leave the grid invisible. The `finally` block clears the timer. If the failsafe fires, the grid shows with nothing hidden until the read completes, then hidden cards drop out.
5. `checkMode()`, start the MutationObserver on `document.documentElement` (`childList: true, subtree: true`), add the `popstate` listener, run one `scan()`.

Decisions:
- **One `get(null)` serves both prune and load.** The spec lists prune then load as separate steps. One read is equivalent and halves the latency before the pending class is lifted.
- **Rule shape.** Each item gets one rule with a three-part selector list:
  ```css
  html.cthide-grid .listitem:has(a.image-container:is([href*="/item/ID/"], [href$="/item/ID"], [href*="/item/ID?"])) { display: none !important; }
  ```
  **Assumption:** item hrefs may appear as `/item/ID/slug`, `/item/ID`, or `/item/ID?query`. All three are covered, so the spec's "if an href can end at the ID" question does not need a live check. The match works for both relative and absolute hrefs. Alternative considered: tag cards with `data-cthide-id` from JS and match on the attribute. Rejected, because re-rendered nodes lose the attribute and flash before the next scan.
- **The style element is re-attached in `scan()` if missing.** A framework that rewrites `<head>` or the document could drop it. The check is one `isConnected` read per frame.
- **The observer feeds back into itself.** Adding buttons and rewriting the style both mutate the DOM. `scan()` is idempotent, because it skips cards that already have a button and `renderRules()` is not called from `scan()`. So the loop settles after one extra frame. Alternative considered: disconnect the observer around own writes. Rejected, because it is extra code for no gain.
- **Button placement.** Append to `.itemcard`, not inside `<a>`. One delegated listener per event type sits on `window` in the capture phase (`onButtonEvent`). It matches `e.target.closest(".cthide-btn")` and calls `preventDefault()` and `stopImmediatePropagation()`. It runs before any site handler, including site capture listeners on `document`. Alternative considered: a listener on each button. Rejected, because a site capture-phase handler on an ancestor would still see the event first. Swallowed events: `pointerdown`, `mousedown`, `mouseup`, `click`, `auxclick`. Hide only when `e.button === 0 && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey`. **Assumption:** Alt-click is also ignored; the spec lists only Ctrl/Shift/Meta.
- **Keyboard.** Enter and Space on a `<button type="button">` fire `click` with `button === 0` and no modifiers, so the same path handles them.
- **Hide flow (`hideFromCard`).**
  1. `prev = hidden.get(id)`. `entry = { hiddenAt: Date.now(), ...readCardInfo() }`.
  2. `hidden.set(id, entry)` and `renderRules()`. The card is now `display: none`.
  3. `focusNextButton(card)`: walk following `.listitem` siblings in DOM order. Focus the first one whose `checkVisibility()` is true and that has a `.cthide-btn`. If there is none, do nothing.
  4. `await storage.local.set({ [key]: entry })`. On reject: restore `prev`, or delete if there was none, then `renderRules()` and `console.error`.
- **`readCardInfo`.** Title: `.itemcard-head` text, trimmed. If empty, use `img.items-image` `alt`. If empty, use `"Item <id>"`. Truncate to 200 chars. URL: `new URL(href, location.origin).href`. Sale ID: regex group 1 from the href.
- **Live sync.** For each changed `hidden:` key: if `newValue` parses and is not expired, `set`; otherwise `delete`. Then `renderRules()` once and `renderBanner()` if in detail mode. The tab's own `set` echoes back here; that is idempotent.
- **Mode changes (`checkMode`).** Toggle `cthide-grid` on `<html>`. Entering `detail` calls `renderBanner()`; leaving it calls `removeBanner()` and resets `bannerDismissedFor`. Moving between two detail items also resets the banner: the mode is the same but the item ID differs, so `checkMode` compares the pathname too.
- **Banner.** Appended to `document.body`. If `body` does not exist yet, the next observer tick retries. Built with `createElement`/`textContent`, never `innerHTML`. Text: `You hid this item <N ago>. Expires in <M>.` **Assumption:** pluralize properly ("1 day", "3 days") instead of the literal "day(s)", and show "today" when N is 0. Unhide calls `storage.local.remove(key)`; the banner goes away through `onChanged`. Dismiss sets `bannerDismissedFor` to the item ID and removes the banner.

### 2.3 `content.css`

```css
html.cthide-pending .listitem { visibility: hidden !important; }
html.cthide-grid .listitem > .itemcard { position: relative; }
.cthide-btn { /* 48x48, absolute top:8px right:8px, z-index:10, round, rgba(0,0,0,.55), no border, pointer */ }
.cthide-btn:hover { background: rgba(0,0,0,.85); }
.cthide-btn:focus-visible { outline: 3px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 5px #000; }
.cthide-btn svg { width: 24px; height: 24px; stroke: #fff; stroke-width: 2.5; fill: none; pointer-events: none; }
#cthide-banner { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; ... }
```

Decision: the focus ring is white with a black halo, so it shows on both light and dark item photos. `pointer-events: none` on the SVG keeps `e.target` on the button.

### 2.4 Popup: `popup/popup.html`, `popup.js`, `popup.css`

```html
<script src="../common.js"></script>
<script src="popup.js"></script>
```

```js
async function load() -> Entry[]        // get(null) -> partition().live, sorted by hiddenAt desc, with itemId attached
function render(items)                  // header, Clear all, rows, or empty state
function renderRow(item) -> HTMLLIElement
async function unhide(itemId)           // remove(key); remove row optimistically
function onClearClick()                 // two-click state machine
browser.storage.onChanged.addListener(() => load().then(render))
```

Decisions:
- **Title link.** A `<button>` styled as a link, which calls `browser.tabs.create({ url })` and then `window.close()`. Before opening, the URL is checked: `https:` or `http:`, and the hostname is `ctbids.com` or ends with `.ctbids.com`. Otherwise the title is shown as plain text. Reason: the URL is page-derived data. Alternative considered: `<a target="_blank">`. Rejected, because popup anchors are unreliable in Firefox.
- **Clear all state machine.** States `idle` and `armed`. The first click arms it: the label becomes `Confirm clear (<count>)` and a 3000 ms timer starts. A second click while armed clears the timer and removes every key that starts with `hidden:`, including expired ones. A timeout returns the button to `idle`. A re-render from `onChanged` keeps the armed state but updates the count.
- **Re-render on every `onChanged`.** A full rebuild is fine for hundreds of rows. The scroll position is saved and restored around the rebuild.
- All text goes through `textContent`.

### 2.5 `manifest.json`

Replace with the spec's manifest verbatim: `storage` permission, `action` with popup, `strict_min_version: "140.0"`, `content_scripts` with `common.js`, `content.js`, `content.css`, and `run_at: document_start`.

### 2.6 Housekeeping

- Delete `hide.js`.
- Update `CLAUDE.md` Overview and Structure for the new files. Keep the Development section and add a pointer to the manual checklist in `SPEC.md`.

### 2.7 Build order

1. `common.js`
2. `manifest.json` + `content.css` + `content.js`, hiding path only
3. Buttons and click handling
4. Live sync
5. Detail banner
6. Popup
7. Delete `hide.js`, update `CLAUDE.md`
8. Run the 13-step manual checklist from `SPEC.md`

Each step is loadable and testable in `about:debugging` on its own.

## 3. Risks and open questions

**Risks**
- **Site markup is only observed, not contracted.** All selectors come from one card snippet. A class rename silently disables the extension: no buttons, nothing hidden. Mitigation: all selectors live in `CTHIDE.SEL` and `CTHIDE.RE`. There is no automated check; it is found only by use.
- **Framework reconciliation vs injected nodes.** The site framework is unknown (React? Vue? server-rendered plus jQuery?). Some reconcilers throw or misbehave when foreign children appear inside managed nodes. Appending as the last child of `.itemcard` is the least risky option. If errors show up in the console, the fallback is to append the button to `.listitem` and position it relative to that, with a matching CSS change.
- **`:has()` cost under per-second mutations.** Hundreds of `:has()` rules plus a countdown mutating every card each second could cost style recalc time. This needs a profile on a large sale with about 200 hidden items. Mitigation if slow: merge all items into one rule with an `:is(...)` list, or narrow to `.listitem:has(> .itemcard a.image-container...)`.
- **Flash prevention depends on `document_start` ordering.** If `documentElement` is somehow null at injection, the pending class cannot be set and a brief flash occurs. Guard with a null check; accept the flash in that case.
- **`storage.local.get` never settles.** `finally` covers rejection, not a hang. A hang would leave the grid invisible. Mitigated by the 2 s failsafe timer in `init` (approved addition to the spec).
- **SPA navigation without DOM mutation.** Mode detection relies on the observer and `popstate`. A `pushState` route change that mutates nothing would be missed. The countdown timer makes that practically impossible on a grid page.
- **Read/onChanged race at startup.** Handled by registering the listener first and merging (see 2.2). It is still the subtlest code path; review it carefully.

**Cannot be fully tested locally**
- **10-day TTL in real time.** Only simulated by editing `hiddenAt` (checklist item 12).
- **Persistence across browser restarts.** Temporary add-ons are removed when Firefox closes, and their `storage.local` may be cleared with them. Real restart persistence needs a signed (unlisted AMO) build, or Developer Edition/Nightly with `xpinstall.signatures.required=false`.
- **Live-site behavior generally.** There is no fixture page. All checks run against production ctbids.com, whose inventory changes and whose sales close.
- **Concurrent cross-tab hides.** The design makes them race-free, but a true simultaneous click cannot be reproduced reliably by hand.

**Open questions**
1. Do item hrefs ever end at the ID, or carry a query string? The plan covers all three forms. Confirm on the live site and drop unused selector parts if they turn out to be dead weight.
2. Does `ctbids.com` serve grid pages on a host other than `www.`/bare (for example a regional subdomain)? The match pattern covers all subdomains, but path formats there are unverified.
3. Is the Alt-click being ignored, and the "today" and pluralized banner wording, acceptable deviations from the spec's literal text?
