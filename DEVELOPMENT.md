# Development

How to change the extension, test it, and ship it. For what the extension does, see `README.md`. For the full behavior spec, see `SPEC.md`.

## Setup

- Firefox 140 or later (desktop).
- Node 22.12 or later, for the tests only. The extension itself has no build step and no runtime dependencies.

```sh
npm install
```

## Project layout

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest. Content scripts run on `*://*.ctbids.com/*` at `document_start`. |
| `common.js` | Shared `CTHIDE` object: TTL, storage key prefix, **all site selectors and URL regexes**, entry and expiry helpers. Loaded by both the content script and the popup. |
| `content.js` | Page mode detection, TTL prune, generated `<style id="cthide-rules">`, hide buttons, live sync, detail-page banner. |
| `content.css` | Anti-flash rule, button and banner styles. |
| `popup/` | Toolbar popup: list, Unhide, two-click Clear all. |
| `test/` | Vitest + happy-dom test suite. |
| `web-ext-config.mjs` | Keeps tests and dev files out of packaged builds. |

## Making a change

1. **Find the right layer.**
   - The site changed its markup or URLs: edit `CTHIDE.SEL` or `CTHIDE.RE` in `common.js`. Nothing else should hard-code a selector or path.
   - Storage, expiry or date maths: `common.js`.
   - Behavior on ctbids.com pages: `content.js`, plus `content.css` for styling.
   - Popup: `popup/`.
2. **Write or update a test first**, or in the same change (see [Writing tests](#writing-tests)). Every behavior change and every bug fix needs a test that fails without the change.
3. **Run the tests:** `npm test`. All tests must pass before the change is done.
4. **Check in Firefox** if the change affects rendering, real site markup or event handling. Tests can't see those (see [What the tests do not cover](#what-the-tests-do-not-cover)):
   1. Open `about:debugging#/runtime/this-firefox`.
   2. Click **Load Temporary Add-on…** and select `manifest.json`. After later edits, click **Reload** there.
   3. Run the relevant steps of the manual checklist at the end of `SPEC.md`.
5. **Update the docs** when behavior changes:
   - `SPEC.md` for behavior.
   - `README.md` for anything a user sees, such as supported pages or the expiry period.
   - `CLAUDE.md` and this file if the structure or workflow changes.

Rules the code relies on:
- Never select site elements by `id`. Every card has `id="cardid"`.
- Hiding is CSS-only, through generated rules scoped under `html.cthide-grid`. Never set `style.display` on site nodes or remove them; the site's React framework re-renders cards constantly.
- Prefix every injected class or ID with `cthide-`.
- Build DOM with `createElement` and `textContent`. Never use `innerHTML` with stored or page-derived data.
- Item IDs go into CSS selectors, so they must pass `CTHIDE.RE.itemId` (digits only).

## Running tests

```sh
npm test              # single run (CI-style)
npm run test:watch    # re-run on file changes
npx vitest run test/content.test.js       # one file
npx vitest run -t "detail page banner"    # tests whose name matches
```

| File | Covers |
|---|---|
| `test/common.test.js` | Pure helpers in `common.js`: mode detection, keys, entry parsing, expiry, day maths, `partition`. |
| `test/content.test.js` | Content script: buttons, click handling, hiding, startup and prune, anti-flash and failsafe, live sync and cross-tab, in-app navigation, detail banner. |
| `test/popup.test.js` | Popup: list, sorting, unsafe URLs, Unhide, Clear all. |

## Writing tests

### How the harness works

`test/helpers.js` gives each test a fresh happy-dom `Window`. Into that window it loads the real extension files: `common.js` with `content.js`, or `common.js` with `popup/popup.js`. It also provides a fake `browser` API backed by in-memory storage. Close windows in `afterEach` with `closeAllWindows()`.

| Helper | Use |
|---|---|
| `bootContent({ url, html, storage, withCss, wait })` | Boot the content script on a page URL with initial body HTML. Returns `{ win, doc, browser, storage }`. Omit `html` to simulate `document_start`. `withCss: true` also applies `content.css`. |
| `bootPopup({ storage })` | Boot the popup with its real markup. `win.close` and `browser.tabs.create` are `vi.fn`. |
| `createStorage(initial)` | Fake `storage.local` + `onChanged`. `storage.data` is the live contents. `get`/`set`/`remove` are `vi.fn`, so you can inject failures or delays. Pass the same instance to two `bootContent` calls to simulate two tabs. |
| `gridHtml(cards)`, `cardHtml({ itemId, title, href, saleId })` | Card markup matching the real site. `href: null` makes a card with no link. |
| `entry(overrides)` | A valid storage entry, hidden now. |
| `cardFor(doc, itemId)`, `click(win, el, init)` | Find a card, dispatch a click (with `button` or modifier keys in `init`). |
| `isHidden(win, el)`, `style(win, el)` | Read computed style. **Always use these, not `getComputedStyle`** (see gotchas). |
| `settle()` | Let timers, `requestAnimationFrame` scans, MutationObserver callbacks and `onChanged` events run. Call it after any DOM or storage change before asserting. |
| `CTHIDE` | The real constants. Use `CTHIDE.TTL_MS` and `CTHIDE.DAY_MS` instead of hard-coding durations. |

### Example

```js
import { afterEach, expect, test } from "vitest";
import { bootContent, cardFor, click, closeAllWindows, createStorage, gridHtml, isHidden, settle } from "./helpers.js";

afterEach(closeAllWindows);

test("hiding in one tab hides the card in another", async () => {
  const storage = createStorage();
  const items = [{ itemId: "111" }, { itemId: "222" }];
  const tabA = await bootContent({ html: gridHtml(items), storage });
  const tabB = await bootContent({ html: gridHtml(items), storage });

  click(tabA.win, cardFor(tabA.doc, "111").querySelector(".cthide-btn"));
  await settle();

  expect(isHidden(tabB.win, cardFor(tabB.doc, "111"))).toBe(true);
});
```

Common patterns:
- **Storage failure:** `storage.local.set.mockRejectedValueOnce(new Error("x"))` before booting or clicking. Silence the expected log with `vi.spyOn(win.console, "error").mockImplementation(() => {})`.
- **Slow or hanging read:** `storage.local.get.mockReturnValueOnce(promise)` with a promise you resolve later, or never.
- **Timers** (failsafe, Clear all reset): call `vi.useFakeTimers()`, then `vi.advanceTimersByTimeAsync(ms)`. Call `vi.useRealTimers()` in `afterEach`.
- **In-app navigation:** `win.history.pushState({}, "", "/new/path")`, then change the DOM (for example append a `div`), then `await settle()`. The content script re-checks the mode on DOM changes and on `popstate`.

### Gotchas

- **Scripts share one scope.** Firefox runs content scripts from one manifest entry in a shared global scope. The harness reproduces this by joining the files into one `eval`. If you add a new script file, add it to `SRC` in `test/helpers.js` and to the `runScripts` call in `bootContent` or `bootPopup`, in manifest order.
- **Stale computed styles.** happy-dom does not invalidate its style cache when a class changes on `<html>`, which happens with `cthide-grid` and `cthide-pending`. `style()` and `isHidden()` clear the cache through a happy-dom internal symbol. If a happy-dom upgrade breaks them, fix `style()` in `test/helpers.js`.
- **Attribute changes do not trigger a scan.** The MutationObserver watches `childList` only. Tests that change an `href` in place are testing the click-time ID lookup, not the scan.
- **Check that a new test can fail.** Break the code it covers, confirm the test fails, then restore the code.

## What the tests do not cover

happy-dom has no layout engine and no real ctbids.com page. These need a manual check in Firefox:
- Visual layout: button position and size, overlap with the watchlist and Bid Now buttons, the grid closing the gap.
- No visible flash on page load.
- Whether the real site's markup and React event handlers still match the assumptions in `common.js`.
- The toolbar popup's size and scrolling.
- Persistence across browser restarts. This needs a permanent install; see `README.md`.

## Releasing

1. Raise `version` in `manifest.json`.
2. Run `npm test`.
3. Package or sign the extension (see `README.md` → Install). `npx web-ext lint` is a quick manifest check first. `web-ext-config.mjs` keeps tests, docs and npm files out of the package.
