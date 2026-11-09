# Hide CTBid Items — Spec

## Goal

Firefox desktop extension. On a ctbids.com estate sale item grid, every item card gets a 48x48 button in its top-right corner. Clicking it hides the item. The grid then behaves as if the item never existed. Hidden state persists across refreshes for 10 days, then expires and is cleaned up. A toolbar popup lists hidden items and can unhide them.

## Scope

In scope:
- Item grid pages (query strings allowed, e.g. paging/sorting). All render the same `.listitem` grid and item card:
  - Sale grid: `/estate-sale/<saleId>`.
  - Category grid: `/category/<group>`, `/category/<group>/<category>`, `/category_list/<category>`.
  - Search results and item lists: `/view-more-items/<type-or-term>`, e.g. `/view-more-items/watch` (site search) or `/view-more-items/trending-now`.
  - Combined regex: `^/(?:estate-sale/\d+|category(?:/[^/]+){1,2}|category_list/[^/]+|view-more-items/[^/]+)/?$`.
- Item detail pages: path matches `^/(?:estate-sale|view-more-items)/\d+/item/\d+(/|$)`. These get a banner only, no hide button.
- Toolbar popup.
- Firefox desktop.

Out of scope:
- Watchlist (`/watching`), sale list (`/estate-sale/list`), location, home and account pages. No buttons; cards there are not hidden.
- Firefox for Android.
- Backfilling short pages, rewriting item counts or totals, next/prev navigation.
- In-page undo toast.

## Site markup (observed)

One card:

```html
<div id="cardid" class="listitem col">
  <div class="itemcard">
    <div class="borderview"><div>
      <a class="image-container ... clickable" href="/estate-sale/48813/item/5684472/Ward-Furniture-Mfg-Co-Nightstand">
        <img alt="Ward Furniture Mfg Co Nightstand" class="items-image" ...>
      </a>
      <div class="m-3">
        ...
        <div class="itemcard-head">Ward Furniture Mfg Co Nightstand</div>
        ... live countdown timer, watchlist (eye icon) button, Bid Now button ...
```

Selectors:

| Purpose | Selector / rule |
|---|---|
| Card root (element to hide) | `.listitem` |
| Button host | `.itemcard` (direct child of `.listitem`) |
| Item link | `a.image-container[href]` inside the card |
| Item ID, sale ID | `href` regex `/estate-sale/(\d+)/item/(\d+)` → group 1 = sale ID, group 2 = item ID |
| Title | `.itemcard-head` text, trimmed; fallback `img.items-image` `alt`; fallback `"Item <id>"` |

Notes:
- Every card has `id="cardid"`. Never select by `id`.
- `.listitem` is a Bootstrap `.col`. `display: none` on it makes the grid reflow with no gap.
- The countdown re-renders every second, so the site's framework may replace card nodes at any time. Hiding must not depend on per-node state, and buttons must be re-added when missing.
- The site's watchlist control uses an eye icon in the card's bottom bar. The hide button uses an X icon to avoid confusion. Nothing occupies the card's top-right corner, so no offset is needed.

All selectors and regexes live in one constants block at the top of `common.js`, so a site markup change is a one-place fix.

## Storage

`browser.storage.local`. Requires the `storage` permission.

One key per hidden item:

```
key:   "hidden:<itemId>"           e.g. "hidden:5684472"
value: {
  hiddenAt: <number, epoch ms>,
  saleId:   "<saleId>",
  title:    "<string, max 200 chars>",
  url:      "<absolute item URL>"
}
```

Why one key per item: tabs write concurrently. A single shared object would need read-modify-write, and two tabs hiding at the same moment would overwrite each other. Per-key `set`/`remove` has no such race. `storage.onChanged` also reports changes per key.

Constants:
- `TTL_MS = 10 * 24 * 60 * 60 * 1000` (864,000,000 ms).
- An entry is expired when `now >= hiddenAt + TTL_MS`.

Rules:
- Hiding an already-hidden item overwrites the entry. The timer resets to now.
- Every reader (content script, popup) ignores expired entries, even ones not yet pruned.
- Entries with a malformed value (missing or non-numeric `hiddenAt`) are treated as expired and pruned.

## TTL cleanup

On every content-script load on any ctbids.com page:
1. `browser.storage.local.get(null)`.
2. Collect keys starting with `hidden:` that are expired or malformed.
3. `browser.storage.local.remove(keys)` if any.

No background script, no alarms. An item that expires while a tab stays open remains hidden in that tab until the next page load. This is accepted.

## Content script

Files: `common.js`, `content.js` and `content.css`, registered for `*://*.ctbids.com/*` with `"run_at": "document_start"`. This replaces `hide.js` and its red-border placeholder.

### Page detection

The site may change pages without a full reload. `content.js` keeps a `currentMode` of `grid`, `detail` or `none`, derived from `location.pathname`. It re-checks the mode:
- at startup,
- on `popstate`,
- in the MutationObserver callback (route changes always mutate the DOM).

On a mode change:
- `<html>` gets class `cthide-grid` only in `grid` mode. All hide CSS is scoped under this class, so it never affects other pages.
- Entering `detail` mode renders the banner check. Leaving it removes the banner.

### Hiding (CSS-driven, no flash)

Hidden cards are hidden by a generated stylesheet, not by touching card nodes. This survives framework re-renders and new cards with no extra work.

1. At `document_start`, if the path is a grid page, add class `cthide-pending` to `<html>`. `content.css` contains:
   ```css
   html.cthide-pending .listitem { visibility: hidden !important; }
   ```
   This blocks the flash of to-be-hidden cards while storage loads.
2. Prune expired entries (see TTL cleanup). Load the remaining entries into an in-memory `Map<itemId, entry>`.
3. Write a `<style id="cthide-rules">` element, appended to `document.documentElement` because `<head>` may not exist yet. It holds one rule per hidden item:
   ```css
   html.cthide-grid .listitem:has(a.image-container[href*="/item/5684472/"]) { display: none !important; }
   ```
   The match includes the trailing `/` so item `56` does not match `5684472`. If an href can end at the ID with no slug, also emit a rule with `href$="/item/<id>"`.
4. Remove `cthide-pending`. Do this in a `finally` block, so a storage failure never leaves the grid invisible.

The `:has()` selector needs Firefox 121 or later. The manifest's `strict_min_version` covers this.

Regenerate the whole `<style>` text whenever the Map changes. It holds tens to low hundreds of rules, which is cheap.

### Buttons

A `MutationObserver` on `document.documentElement` (`childList`, `subtree`) watches for cards. Its callback is batched with `requestAnimationFrame`, so the per-second timer churn runs at most one scan per frame. Each scan, in grid mode only:
- For each `.listitem` with no `.cthide-btn` inside its `.itemcard`:
  - Parse the item ID from `a.image-container[href]`. If missing or unparseable, skip the card: no button, never hidden.
  - Append a button to `.itemcard`. It must not go inside the `<a>`: a button inside a link is invalid HTML and would trigger navigation.
  - Store the item ID on the button as `data-cthide-id`.

Button markup and style:
- `<button type="button" class="cthide-btn" aria-label="Hide item" title="Hide item">` with an inline SVG X icon, 24x24, `stroke: white`.
- 48x48 px, `position: absolute; top: 8px; right: 8px; z-index: 10`.
- `.itemcard` gets `position: relative` from `content.css`, scoped under `html.cthide-grid`.
- Circular, `background: rgba(0,0,0,0.55)`. Opaque `rgba(0,0,0,0.85)` on `:hover`. Visible `:focus-visible` outline. `cursor: pointer`, no border.
- Always visible, not hover-only.
- All class names are prefixed `cthide-` to avoid collisions with site CSS.

Click handling. The button swallows every pointer interaction so the card never opens from it:
- `pointerdown`, `mousedown`, `mouseup`, `click`, `auxclick`: `preventDefault()` and `stopPropagation()`.
- Only a primary-button `click` with no modifier keys hides the item. Middle-click and Ctrl/Shift/Meta-click do nothing.
- Keyboard: Enter and Space work through native `<button>` behavior.

On hide:
1. Read the title and URL from the card. Resolve the URL to absolute with `new URL(href, location.origin)`.
2. Update the in-memory Map and regenerate the style first, so the card vanishes instantly.
3. Move focus to the hide button of the next visible card, if one exists.
4. `browser.storage.local.set({ "hidden:<id>": entry })`. On failure, roll back the Map and style so the card reappears, and `console.error`.

Duplicates: if the same item ID appears in more than one card on a page, hiding one hides all. The CSS rule matches by ID.

### Live sync

`browser.storage.onChanged` (area `local`), for keys starting with `hidden:`:
- `newValue` present and not expired: add to the Map.
- `newValue` absent (removed): delete from the Map.
- Regenerate the style.

This makes a hide in one tab vanish in other open tabs, and a popup unhide bring the card back with no refresh.

### Detail page banner

In `detail` mode, if the item ID from the URL is in the Map:
- Insert a fixed banner at the top of the viewport, `id="cthide-banner"`, with a high `z-index`.
- Text: `You hid this item <N> day(s) ago. Expires in <M> day(s).` followed by an `Unhide` button and a dismiss (X) button.
- Unhide removes the storage key. The banner goes away through `onChanged`.
- Dismiss removes the banner for this page view only.
- Leaving detail mode or unhiding removes the banner.

Day math: `N = floor((now - hiddenAt) / DAY)`, `M = ceil((hiddenAt + TTL_MS - now) / DAY)`.

## Toolbar popup

Manifest `action.default_popup: "popup/popup.html"`. Files: `popup/popup.html`, `popup/popup.js`, `popup/popup.css`. The popup loads `common.js` with a script tag for the shared constants.

On open:
- Read all `hidden:` entries and drop expired ones (display only, no prune).
- Sort by `hiddenAt` descending.

Layout:
- Header: "Hidden items (<count>)" and a "Clear all" button.
- One row per item:
  - Title, which opens `url` in a new tab via `browser.tabs.create`. That call needs no permission.
  - "<M> days left".
  - "Unhide" button. It removes the key and removes the row.
- Empty state: "No hidden items."
- Fixed width of about 360px. The list scrolls past about 500px of height.

Clear all needs two clicks, because `window.confirm()` is unreliable in Firefox popups. The first click changes the button to "Confirm clear (<count>)". A second click within 3 seconds removes all `hidden:` keys; otherwise the button reverts.

The popup re-renders on `storage.onChanged`, so it stays correct if a tab hides something while it is open.

## Manifest

```json
{
  "manifest_version": 3,
  "name": "Hide CTBid Items",
  "version": "1.0",
  "description": "Hide items on ctbids.com.",
  "icons": { "48": "icons/icon-48.png" },
  "permissions": ["storage"],
  "action": {
    "default_icon": { "48": "icons/icon-48.png" },
    "default_title": "Hidden CTBid items",
    "default_popup": "popup/popup.html"
  },
  "browser_specific_settings": {
    "gecko": {
      "id": "hide@ctbids.com",
      "strict_min_version": "140.0",
      "data_collection_permissions": { "required": ["none"] }
    }
  },
  "content_scripts": [
    {
      "matches": ["*://*.ctbids.com/*"],
      "js": ["common.js", "content.js"],
      "css": ["content.css"],
      "run_at": "document_start"
    }
  ]
}
```

`strict_min_version` is 140.0 because `data_collection_permissions` requires Firefox 140. That also covers `:has()` (121+). `*://*.ctbids.com/*` matches both `ctbids.com` and `www.ctbids.com`.

## File layout

```
manifest.json
common.js        constants (TTL, key prefix, selectors, path regexes), entry parse/expiry helpers
content.js       mode detection, prune, style rules, buttons, banner, live sync
content.css      pending rule, button and banner styles, .itemcard positioning
popup/popup.html
popup/popup.js
popup/popup.css
icons/icon-48.png
```

Delete `hide.js`. Update `CLAUDE.md` to match the new files.

## Edge cases

| Case | Behavior |
|---|---|
| Card has no item link or ID | No button; never hidden |
| Framework replaces card nodes (timer ticks) | CSS rules still apply; observer re-adds the button |
| Site navigates without a reload | Mode re-checked in the observer callback and on `popstate` |
| Same item in two cards | Both hidden |
| Hide in tab A while tab B shows the same sale | B hides the card live via `onChanged` |
| Two tabs hide different items at the same moment | Per-item keys, no lost writes |
| Storage write fails | Card reappears; error logged |
| Storage read fails at load | `cthide-pending` removed in `finally`; grid shows with nothing hidden |
| Item expires while the tab is open | Stays hidden until the next page load |
| Page shows fewer items than its page size | Accepted; site counts and pagination unchanged |
| Item hidden, then opened from watchlist or a link | Detail page banner with Unhide |
| Malformed storage value | Treated as expired; pruned on next load |

## Manual test checklist

No test framework. Load via `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → `manifest.json`.

1. Sale grid: every card shows a 48x48 X button in its top-right corner. It does not cover the watchlist or Bid Now buttons.
2. Click X: the card vanishes, the grid closes the gap, and the page does not navigate.
3. Middle-click and Ctrl+click on X: nothing happens, and no tab opens.
4. Refresh: the item stays hidden, with no visible flash.
5. Paginate to another page and back: hidden items stay hidden and buttons appear on new cards.
6. Two tabs on the same sale: hiding in one removes the card from the other.
7. Popup: lists the item with title, days left and Unhide. Unhide brings the card back in open tabs without a refresh.
8. Clear all: needs a second click; reverts after 3 seconds.
9. Open a hidden item's detail page: the banner shows; Unhide works; dismiss works.
10. Category (`/category/Jewelry`) and search (`/view-more-items/<term>`) pages: buttons show, hiding works, and items hidden on a sale page are hidden here too.
11. Watchlist page: no buttons, and nothing is hidden.
12. TTL: in the devtools console, set an entry's `hiddenAt` to 11 days ago (`browser.storage.local.set` from the extension's debug console), reload a ctbids page, and confirm the key is gone and the card is visible.
13. Tab focus: Tab reaches the X button; Enter hides; focus moves to the next card's button.
