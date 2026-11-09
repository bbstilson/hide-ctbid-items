import { afterEach, describe, expect, test, vi } from "vitest";
import { CTHIDE, bootPopup, click, closeAllWindows, createStorage, entry, settle } from "./helpers.js";

afterEach(async () => {
  vi.useRealTimers();
  await closeAllWindows();
});

const DAY = CTHIDE.DAY_MS;
const ttlDays = CTHIDE.TTL_MS / DAY;
const rows = (doc) => [...doc.querySelectorAll("#list .row")];
const rowTitles = (doc) => rows(doc).map((r) => r.querySelector(".title").textContent);

describe("list", () => {
  test("shows live items newest first and skips expired ones", async () => {
    const now = Date.now();
    const storage = createStorage({
      "hidden:1": entry({ title: "Older", hiddenAt: now - 2 * DAY }),
      "hidden:2": entry({ title: "Newer", hiddenAt: now }),
      "hidden:3": entry({ title: "Expired", hiddenAt: now - CTHIDE.TTL_MS }),
      "hidden:4": { title: "Malformed" },
    });
    const { doc } = await bootPopup({ storage });

    expect(rowTitles(doc)).toEqual(["Newer", "Older"]);
    expect(doc.getElementById("count").textContent).toBe("2");
    expect(rows(doc)[0].querySelector(".left").textContent).toBe(`${ttlDays} days left`);
    expect(rows(doc)[1].querySelector(".left").textContent).toBe(`${ttlDays - 2} days left`);
    expect(doc.getElementById("empty").hidden).toBe(true);
  });

  test("does not prune expired entries", async () => {
    const storage = createStorage({ "hidden:3": entry({ hiddenAt: 0 }) });
    await bootPopup({ storage });
    expect(storage.local.remove).not.toHaveBeenCalled();
  });

  test("shows the empty state", async () => {
    const { doc } = await bootPopup();
    expect(doc.getElementById("empty").hidden).toBe(false);
    expect(doc.getElementById("count").textContent).toBe("0");
    expect(doc.getElementById("clear").disabled).toBe(true);
  });

  test("renders titles as text, not HTML", async () => {
    const storage = createStorage({ "hidden:1": entry({ title: "<img src=x onerror=alert(1)>" }) });
    const { doc } = await bootPopup({ storage });
    expect(doc.querySelector("#list img")).toBeNull();
    expect(rowTitles(doc)).toEqual(["<img src=x onerror=alert(1)>"]);
  });

  test("re-renders when storage changes while open", async () => {
    const storage = createStorage();
    const { doc } = await bootPopup({ storage });
    await storage.local.set({ "hidden:5": entry({ title: "From a tab" }) });
    await settle();
    expect(rowTitles(doc)).toEqual(["From a tab"]);
  });
});

describe("title link", () => {
  test("opens ctbids URLs in a new tab and closes the popup", async () => {
    const url = "https://www.ctbids.com/estate-sale/1/item/5/x";
    const storage = createStorage({ "hidden:5": entry({ url }) });
    const { win, doc, browser } = await bootPopup({ storage });

    click(win, doc.querySelector(".title.link"));
    await settle();
    expect(browser.tabs.create).toHaveBeenCalledWith({ url });
    expect(win.close).toHaveBeenCalled();
  });

  test.each(["javascript:alert(1)", "https://evil.example/ctbids.com", "https://ctbids.com.evil.example/", ""])(
    "shows plain text for unsafe URL %j",
    async (url) => {
      const storage = createStorage({ "hidden:5": entry({ url }) });
      const { doc } = await bootPopup({ storage });
      expect(doc.querySelector(".title.link")).toBeNull();
      expect(doc.querySelector("span.title")).not.toBeNull();
    }
  );
});

describe("unhide", () => {
  test("removes the key and the row", async () => {
    const storage = createStorage({
      "hidden:1": entry({ title: "A" }),
      "hidden:2": entry({ title: "B", hiddenAt: Date.now() - 1000 }),
    });
    const { win, doc } = await bootPopup({ storage });

    click(win, rows(doc)[0].querySelector(".unhide"));
    expect(rowTitles(doc)).toEqual(["B"]);
    expect(doc.getElementById("count").textContent).toBe("1");
    await settle();
    expect(storage.data["hidden:1"]).toBeUndefined();
    expect(storage.data["hidden:2"]).toBeDefined();
  });
});

describe("clear all", () => {
  function seeded() {
    return createStorage({
      "hidden:1": entry(),
      "hidden:2": entry(),
      "hidden:3": entry({ hiddenAt: 0 }), // expired: also removed
      "other": "kept",
    });
  }

  test("needs a second click, then removes every hidden key", async () => {
    const storage = seeded();
    const { win, doc } = await bootPopup({ storage });
    const btn = doc.getElementById("clear");

    click(win, btn);
    expect(btn.textContent).toBe("Confirm clear (2)");
    expect(storage.local.remove).not.toHaveBeenCalled();

    click(win, btn);
    await settle();
    expect(storage.data).toEqual({ other: "kept" });
    expect(btn.textContent).toBe("Clear all");
    expect(doc.getElementById("empty").hidden).toBe(false);
  });

  test("reverts after 3 seconds without a second click", async () => {
    vi.useFakeTimers();
    const storage = seeded();
    const { win, doc } = await bootPopup({ storage });
    const btn = doc.getElementById("clear");

    click(win, btn);
    await vi.advanceTimersByTimeAsync(2999);
    expect(btn.textContent).toBe("Confirm clear (2)");
    await vi.advanceTimersByTimeAsync(1);
    expect(btn.textContent).toBe("Clear all");

    click(win, btn);
    expect(storage.local.remove).not.toHaveBeenCalled();
  });
});
