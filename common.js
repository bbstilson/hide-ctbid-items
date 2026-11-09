// Shared constants and helpers for the content script and the popup.
// All site selectors and regexes live here, so a markup change is a one-place fix.

const CTHIDE = Object.freeze({
  DAY_MS: 24 * 60 * 60 * 1000,
  TTL_MS: 14 * 24 * 60 * 60 * 1000,
  KEY_PREFIX: "hidden:",
  TITLE_MAX: 200,
  PENDING_FAILSAFE_MS: 2000,

  SEL: Object.freeze({
    card: ".listitem",
    host: ".listitem > .itemcard",
    link: "a.image-container[href]",
    title: ".itemcard-head",
    img: "img.items-image",
  }),

  RE: Object.freeze({
    itemHref: /\/estate-sale\/(\d+)\/item\/(\d+)/, // 1 = saleId, 2 = itemId
    // Pages that render the shared .listitem item grid:
    //   /estate-sale/<saleId>                   sale grid
    //   /category/<group>[/<category>]          category grid
    //   /category_list/<category>               category grid (same component)
    //   /view-more-items/<type-or-search-term>  search results, trending, ending soon
    gridPath:
      /^\/(?:estate-sale\/\d+|category(?:\/[^/]+){1,2}|category_list\/[^/]+|view-more-items\/[^/]+)\/?$/,
    // Item detail, opened from a sale grid or from search results.
    detailPath: /^\/(?:estate-sale|view-more-items)\/(\d+)\/item\/(\d+)(\/|$)/,
    itemId: /^\d+$/,
  }),

  /** @returns {"grid"|"detail"|"none"} */
  modeFor(pathname) {
    if (CTHIDE.RE.gridPath.test(pathname)) return "grid";
    if (CTHIDE.RE.detailPath.test(pathname)) return "detail";
    return "none";
  },

  keyFor(itemId) {
    return CTHIDE.KEY_PREFIX + itemId;
  },

  /** Returns the item ID, or null if the key is not ours or the ID is not all digits. */
  itemIdFromKey(key) {
    if (typeof key !== "string" || !key.startsWith(CTHIDE.KEY_PREFIX)) return null;
    const id = key.slice(CTHIDE.KEY_PREFIX.length);
    return CTHIDE.RE.itemId.test(id) ? id : null;
  },

  /** Returns a normalized entry, or null if hiddenAt is missing or not a finite number. */
  parseEntry(value) {
    if (!value || typeof value !== "object") return null;
    if (typeof value.hiddenAt !== "number" || !Number.isFinite(value.hiddenAt)) return null;
    return {
      hiddenAt: value.hiddenAt,
      saleId: String(value.saleId ?? ""),
      title: String(value.title ?? "").slice(0, CTHIDE.TITLE_MAX),
      url: String(value.url ?? ""),
    };
  },

  /** Malformed (null) entries count as expired. */
  isExpired(entry, now = Date.now()) {
    return !entry || now >= entry.hiddenAt + CTHIDE.TTL_MS;
  },

  daysAgo(entry, now = Date.now()) {
    return Math.max(0, Math.floor((now - entry.hiddenAt) / CTHIDE.DAY_MS));
  },

  daysLeft(entry, now = Date.now()) {
    return Math.max(0, Math.ceil((entry.hiddenAt + CTHIDE.TTL_MS - now) / CTHIDE.DAY_MS));
  },

  plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  },

  /**
   * Splits a storage.local.get(null) result into live entries and keys to prune.
   * @returns {{ live: Map<string, object>, deadKeys: string[] }}
   */
  partition(all, now = Date.now()) {
    const live = new Map();
    const deadKeys = [];
    for (const [key, value] of Object.entries(all || {})) {
      if (!key.startsWith(CTHIDE.KEY_PREFIX)) continue;
      const id = CTHIDE.itemIdFromKey(key);
      const entry = CTHIDE.parseEntry(value);
      if (id === null || CTHIDE.isExpired(entry, now)) deadKeys.push(key);
      else live.set(id, entry);
    }
    return { live, deadKeys };
  },
});
