import { describe, expect, test } from "vitest";
import { CTHIDE as C } from "./helpers.js";

const NOW = 1_700_000_000_000;
const DAY = C.DAY_MS;

describe("modeFor", () => {
  test.each([
    ["/estate-sale/48813", "grid"],
    ["/estate-sale/48813/", "grid"],
    ["/category/Jewelry", "grid"],
    ["/category/Jewelry/Rings", "grid"],
    ["/category_list/Jewelry", "grid"],
    ["/view-more-items/watch", "grid"],
    ["/view-more-items/trending-now", "grid"],
    ["/estate-sale/48813/item/5684472/Ward-Nightstand", "detail"],
    ["/estate-sale/48813/item/5684472", "detail"],
    ["/view-more-items/48813/item/5684472", "detail"],
    ["/", "none"],
    ["/category", "none"],
    ["/category/a/b/c", "none"],
    ["/watching", "none"],
    ["/estate-sale/list", "none"],
    ["/estate-sale/48813/item/56x", "none"],
    ["/my-account", "none"],
  ])("%s -> %s", (path, mode) => {
    expect(C.modeFor(path)).toBe(mode);
  });
});

describe("keys", () => {
  test("keyFor and itemIdFromKey round-trip", () => {
    expect(C.keyFor("5684472")).toBe("hidden:5684472");
    expect(C.itemIdFromKey("hidden:5684472")).toBe("5684472");
  });

  test.each(["other:1", "hidden:", "hidden:12a", 'hidden:1"]', null, 42])(
    "itemIdFromKey rejects %s",
    (key) => {
      expect(C.itemIdFromKey(key)).toBeNull();
    }
  );
});

describe("parseEntry", () => {
  test.each([undefined, null, "x", {}, { hiddenAt: "1" }, { hiddenAt: NaN }, { hiddenAt: Infinity }])(
    "rejects malformed %j",
    (value) => {
      expect(C.parseEntry(value)).toBeNull();
    }
  );

  test("normalizes fields and truncates title", () => {
    const e = C.parseEntry({ hiddenAt: NOW, saleId: 5, title: "x".repeat(300) });
    expect(e).toEqual({ hiddenAt: NOW, saleId: "5", title: "x".repeat(C.TITLE_MAX), url: "" });
  });
});

describe("expiry and day math", () => {
  const e = { hiddenAt: NOW };

  test("expires exactly at hiddenAt + TTL", () => {
    expect(C.isExpired(e, NOW + C.TTL_MS - 1)).toBe(false);
    expect(C.isExpired(e, NOW + C.TTL_MS)).toBe(true);
    expect(C.isExpired(null, NOW)).toBe(true);
  });

  test("daysAgo floors, daysLeft ceils", () => {
    const ttlDays = C.TTL_MS / DAY;
    expect(C.daysAgo(e, NOW)).toBe(0);
    expect(C.daysLeft(e, NOW)).toBe(ttlDays);
    expect(C.daysAgo(e, NOW + DAY + 1)).toBe(1);
    expect(C.daysLeft(e, NOW + DAY + 1)).toBe(ttlDays - 1);
    expect(C.daysLeft(e, NOW + C.TTL_MS + DAY)).toBe(0);
  });

  test("plural", () => {
    expect(C.plural(0, "day")).toBe("0 days");
    expect(C.plural(1, "day")).toBe("1 day");
    expect(C.plural(3, "day")).toBe("3 days");
  });
});

describe("partition", () => {
  test("splits live entries from expired, malformed and bad keys", () => {
    const { live, deadKeys } = C.partition(
      {
        "hidden:1": { hiddenAt: NOW },
        "hidden:2": { hiddenAt: NOW - C.TTL_MS },
        "hidden:3": { title: "no hiddenAt" },
        "hidden:abc": { hiddenAt: NOW },
        "unrelated": { hiddenAt: 0 },
      },
      NOW
    );
    expect([...live.keys()]).toEqual(["1"]);
    expect(deadKeys.sort()).toEqual(["hidden:2", "hidden:3", "hidden:abc"]);
  });

  test("handles empty or missing input", () => {
    expect(C.partition(undefined, NOW).live.size).toBe(0);
  });
});
