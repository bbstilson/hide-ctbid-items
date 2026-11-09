# Hide CTBid Items

A Firefox extension that lets you hide items you are not interested in on [ctbids.com](https://ctbids.com).

## What it does

- **Hide button on every item card.** Item grids get a round X button in the top-right corner of each card. Click it and the card disappears; the grid closes the gap as if the item was never there. This works on:
  - estate sale pages (`/estate-sale/<id>`)
  - category pages (`/category/Jewelry`, `/category/<group>/<category>`)
  - search results and item lists (`/view-more-items/<term>`, Trending Now, Ending Soon)
- **Hidden items stay hidden for 10 days.** The hide survives page refreshes and is shared across every page type and every open tab. After 10 days the item comes back on its own.
- **Banner on hidden item pages.** If you open a hidden item directly (for example from a link or your watchlist), a banner at the top tells you it is hidden and lets you unhide it.
- **Toolbar popup.** Click the extension's toolbar icon to see all hidden items, how many days each has left, and an Unhide button per item. "Clear all" unhides everything (click twice to confirm).

The extension needs no account and sends no data anywhere. Hidden items are stored locally in your browser (`browser.storage.local`). The only permission it requests is `storage`.

## Requirements

Firefox desktop 140 or later. Firefox for Android and Chrome are not supported.

## Install

Firefox only runs signed extensions permanently on its release version. Pick the option that fits.

### Option 1: Temporary install (quickest, for trying it out)

1. Download or clone this repository.
2. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. Select the `manifest.json` file in this folder.

The extension is active right away. Firefox removes temporary add-ons when it closes, and your hidden items may be lost with it. Repeat these steps after each restart.

### Option 2: Permanent install on Firefox Developer Edition or Nightly

These Firefox versions can run unsigned extensions.

1. Go to `about:config`, search for `xpinstall.signatures.required`, and set it to `false`.
2. Package the extension from this folder:
   ```sh
   zip -r -FS ../hide-ctbids.xpi manifest.json common.js content.js content.css popup icons
   ```
3. Go to `about:addons`, click the gear icon, choose **Install Add-on From File…**, and select `hide-ctbids.xpi`.

### Option 3: Permanent install on regular Firefox (signed)

Sign the extension yourself as an unlisted add-on on addons.mozilla.org. It stays private and is not published in the store.

1. Create an account at [addons.mozilla.org](https://addons.mozilla.org) and generate API credentials under **Tools → Manage API Keys**.
2. Sign the extension with Mozilla's [`web-ext`](https://github.com/mozilla/web-ext) tool:
   ```sh
   npx web-ext sign --channel=unlisted --api-key=<JWT issuer> --api-secret=<JWT secret>
   ```
3. Open the signed `.xpi` from the `web-ext-artifacts/` folder in Firefox to install it.

To release an update, raise `version` in `manifest.json` before signing again.

## Usage

1. Open any ctbids.com estate sale, category, or search results page.
2. Click the X in the corner of a card to hide that item.
3. To bring an item back, use the toolbar popup or the banner on the item's own page.

## Development

There is no build step. Edit the files and click **Reload** next to the extension in `about:debugging`. See `SPEC.md` for the full behavior and the manual test checklist, `PLAN.md` for design decisions, and `CLAUDE.md` for a map of the files.
