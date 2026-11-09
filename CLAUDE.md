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

No build step, package manager, linter, or tests. Files load into the browser as-is.

To run: open `about:debugging#/runtime/this-firefox` in Firefox, click "Load Temporary Add-on", and select `manifest.json`. Click "Reload" there after edits.

Verify changes with the manual test checklist at the end of `SPEC.md`.
