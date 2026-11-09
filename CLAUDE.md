# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Firefox WebExtension (Manifest V3) that hides items on ctbids.com item grids (sale, category and search pages). Each item card gets an X button; hidden items are stored for 10 days and hidden by a generated stylesheet. A toolbar popup lists and unhides them. `SPEC.md` is the spec; `PLAN.md` records design decisions and assumptions.

## Structure

- `manifest.json` — MV3 manifest. Registers `common.js`, `content.js` and `content.css` as content scripts on `*://*.ctbids.com/*` at `document_start`. `browser_specific_settings.gecko` sets the add-on ID (`hide@ctbids.com`), `strict_min_version` 140.0, and declares no data collection.
- `common.js` — shared `CTHIDE` object: TTL, storage key prefix, all site selectors and path regexes, entry parse/expiry helpers. Loaded by the content script and the popup. Site markup changes are fixed here.
- `content.js` — page mode detection (grid/detail/none), TTL prune, generated `<style id="cthide-rules">`, hide buttons, live sync via `storage.onChanged`, detail-page banner.
- `content.css` — pending (anti-flash) rule, button and banner styles.
- `popup/` — toolbar popup listing hidden items, with Unhide and two-click Clear all.
- `icons/icon-48.png` — toolbar/add-on icon.

Storage: `browser.storage.local`, one key per item, `hidden:<itemId>` → `{ hiddenAt, saleId, title, url }`.

## Development

Read `DEVELOPMENT.md` before changing code. It covers the workflow, the test harness (`test/helpers.js`), its gotchas, and what needs a manual check in Firefox.

Rules for every change:
- **Add or update tests** in `test/` for every behavior change or bug fix. Each new test must fail without the change. Confirm this by breaking the code temporarily.
- **Run `npm test` and make sure all tests pass** before reporting a change as done. Run `npm install` first if `node_modules/` is missing. Never skip, weaken or delete a failing test to get a green run; fix the code, or ask if the test itself is wrong.
- In tests, read computed styles with `style()` / `isHidden()` from `test/helpers.js`, never `getComputedStyle` directly (happy-dom cache bug).
- Keep all site selectors and URL regexes in `CTHIDE.SEL` / `CTHIDE.RE` in `common.js`.
- Update `SPEC.md` and `README.md` when behavior changes.
- Tests cannot see layout or the live site. Say so when a change needs a manual check in Firefox, and list which `SPEC.md` checklist steps apply.

To load in Firefox: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → `manifest.json`. Click "Reload" there after edits.
