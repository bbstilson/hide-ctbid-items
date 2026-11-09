import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CTHIDE,
  bootContent,
  cardFor,
  cardHtml,
  click,
  closeAllWindows,
  createStorage,
  entry,
  gridHtml,
  isHidden,
  settle,
  style,
} from "./helpers.js";

const GRID_URL = "https://www.ctbids.com/estate-sale/48813";
const DETAIL_URL = "https://www.ctbids.com/estate-sale/48813/item/111/Lamp";
const ITEMS = [{ itemId: "111" }, { itemId: "222" }, { itemId: "333" }];

afterEach(async () => {
  vi.useRealTimers();
  await closeAllWindows();
});

/** Promise whose resolve/reject the test controls. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("buttons", () => {
  test("adds one hide button per card, outside the item link", async () => {
    const { doc } = await bootContent({ html: gridHtml(ITEMS) });
    const buttons = doc.querySelectorAll(".listitem > .itemcard > .cthide-btn");
    expect(buttons).toHaveLength(3);
    expect([...buttons].map((b) => b.dataset.cthideId)).toEqual(["111", "222", "333"]);

    const btn = buttons[0];
    expect(btn.type).toBe("button");
    expect(btn.getAttribute("aria-label")).toBe("Hide item");
    expect(btn.closest("a")).toBeNull();
    expect(btn.querySelector("svg")).not.toBeNull();
  });

  test("skips cards without a parseable item link", async () => {
    const html = gridHtml([
      { itemId: "111" },
      { itemId: "x", href: null },
      { itemId: "y", href: "/somewhere/else" },
    ]);
    const { doc } = await bootContent({ html });
    expect(doc.querySelectorAll(".cthide-btn")).toHaveLength(1);
  });

  test.each([
    "https://www.ctbids.com/category/Jewelry",
    "https://www.ctbids.com/category/Jewelry/Rings",
    "https://www.ctbids.com/view-more-items/watch",
  ])("works on grid page %s", async (url) => {
    const { doc } = await bootContent({ url, html: gridHtml(ITEMS) });
    expect(doc.documentElement.classList.contains("cthide-grid")).toBe(true);
    expect(doc.querySelectorAll(".cthide-btn")).toHaveLength(3);
  });

  test.each(["https://www.ctbids.com/watching", DETAIL_URL, "https://www.ctbids.com/"])(
    "adds no buttons on non-grid page %s",
    async (url) => {
      const { doc } = await bootContent({ url, html: gridHtml(ITEMS) });
      expect(doc.querySelectorAll(".cthide-btn")).toHaveLength(0);
      expect(doc.documentElement.classList.contains("cthide-grid")).toBe(false);
    }
  );

  test("adds buttons to cards rendered after load", async () => {
    const { doc } = await bootContent({ html: '<div id="grid"></div>' });
    doc.getElementById("grid").innerHTML = gridHtml(ITEMS);
    await settle();
    expect(doc.querySelectorAll(".cthide-btn")).toHaveLength(3);
  });

  test("re-adds the button when the framework replaces a card", async () => {
    const { doc } = await bootContent({ html: gridHtml(ITEMS) });
    cardFor(doc, "222").outerHTML = cardHtml({ itemId: "222" });
    await settle();
    expect(cardFor(doc, "222").querySelector(".cthide-btn")).not.toBeNull();
  });

  test("hides the card's current item when the framework reuses the node", async () => {
    const { win, doc, storage } = await bootContent({ html: gridHtml(ITEMS) });
    const card = cardFor(doc, "111");
    // An attribute change alone does not trigger a scan, so the button is stale.
    card.querySelector("a").setAttribute("href", "/estate-sale/48813/item/999/Other");

    click(win, card.querySelector(".cthide-btn"));
    await settle();
    expect(storage.data["hidden:999"]).toBeDefined();
    expect(storage.data["hidden:111"]).toBeUndefined();
  });
});

describe("hiding", () => {
  test("click hides the card and saves an entry", async () => {
    const { win, doc, storage } = await bootContent({
      html: gridHtml([{ itemId: "111", title: "Brass Lamp" }, { itemId: "222" }]),
    });
    click(win, cardFor(doc, "111").querySelector(".cthide-btn"));
    expect(isHidden(win, cardFor(doc, "111"))).toBe(true);
    expect(isHidden(win, cardFor(doc, "222"))).toBe(false);

    await settle();
    const saved = storage.data["hidden:111"];
    expect(saved).toMatchObject({
      saleId: "48813",
      title: "Brass Lamp",
      url: "https://www.ctbids.com/estate-sale/48813/item/111/Some-Slug",
    });
    expect(Date.now() - saved.hiddenAt).toBeLessThan(5000);
  });

  test("click never reaches the site's handlers or navigates", async () => {
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS) });
    const card = cardFor(doc, "111");
    const siteBubble = vi.fn();
    const siteCapture = vi.fn();
    card.addEventListener("click", siteBubble);
    doc.addEventListener("click", siteCapture, true);
    for (const type of ["pointerdown", "mousedown", "mouseup"]) {
      card.addEventListener(type, siteBubble);
    }

    const btn = card.querySelector(".cthide-btn");
    for (const type of ["pointerdown", "mousedown", "mouseup"]) {
      btn.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    const ev = click(win, btn);

    expect(ev.defaultPrevented).toBe(true);
    expect(siteBubble).not.toHaveBeenCalled();
    expect(siteCapture).not.toHaveBeenCalled();
  });

  test.each([
    ["middle click", { button: 1 }],
    ["ctrl click", { ctrlKey: true }],
    ["shift click", { shiftKey: true }],
    ["meta click", { metaKey: true }],
    ["alt click", { altKey: true }],
  ])("%s does not hide", async (_, init) => {
    const { win, doc, storage } = await bootContent({ html: gridHtml(ITEMS) });
    const ev = click(win, cardFor(doc, "111").querySelector(".cthide-btn"), init);
    await settle();
    expect(ev.defaultPrevented).toBe(true);
    expect(isHidden(win, cardFor(doc, "111"))).toBe(false);
    expect(storage.local.set).not.toHaveBeenCalled();
  });

  test("auxclick is swallowed", async () => {
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS) });
    const ev = new win.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    cardFor(doc, "111").querySelector(".cthide-btn").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  test("title falls back to image alt, then to the item ID", async () => {
    const html = gridHtml([{ itemId: "111", title: "" }]).replace('alt=""', 'alt="From Alt"');
    const { win, doc, storage } = await bootContent({
      html: html + gridHtml([{ itemId: "222", title: "" }]),
    });
    click(win, cardFor(doc, "111").querySelector(".cthide-btn"));
    click(win, cardFor(doc, "222").querySelector(".cthide-btn"));
    await settle();
    expect(storage.data["hidden:111"].title).toBe("From Alt");
    expect(storage.data["hidden:222"].title).toBe("Item 222");
  });

  test("moves focus to the next visible card's button", async () => {
    const storage = createStorage({ "hidden:222": entry() });
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS), storage });
    click(win, cardFor(doc, "111").querySelector(".cthide-btn"));
    expect(doc.activeElement).toBe(cardFor(doc, "333").querySelector(".cthide-btn"));
  });

  test("hides every card with the same item ID", async () => {
    const { win, doc } = await bootContent({
      html: gridHtml([{ itemId: "111" }, { itemId: "222" }, { itemId: "111" }]),
    });
    click(win, cardFor(doc, "111").querySelector(".cthide-btn"));
    const dupes = [...doc.querySelectorAll('.listitem a[href*="/item/111/"]')];
    expect(dupes).toHaveLength(2);
    for (const a of dupes) expect(isHidden(win, a.closest(".listitem"))).toBe(true);
  });

  test("an ID that is a prefix of another does not hide it", async () => {
    const storage = createStorage({ "hidden:56": entry() });
    const { win, doc } = await bootContent({
      html: gridHtml([{ itemId: "56" }, { itemId: "5684472" }]),
      storage,
    });
    expect(isHidden(win, cardFor(doc, "56"))).toBe(true);
    expect(isHidden(win, cardFor(doc, "5684472"))).toBe(false);
  });

  test.each([
    ["no slug", "/estate-sale/48813/item/111"],
    ["query string", "/estate-sale/48813/item/111?ref=x"],
    ["absolute URL", "https://www.ctbids.com/estate-sale/48813/item/111/Slug"],
  ])("matches item links with %s", async (_, href) => {
    const storage = createStorage({ "hidden:111": entry() });
    const { win, doc } = await bootContent({ html: gridHtml([{ itemId: "111", href }]), storage });
    expect(isHidden(win, doc.querySelector(".listitem"))).toBe(true);
  });

  test("restores the card when the save fails", async () => {
    const storage = createStorage();
    storage.local.set.mockRejectedValueOnce(new Error("quota"));
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS), storage });
    const error = vi.spyOn(win.console, "error").mockImplementation(() => {});

    click(win, cardFor(doc, "111").querySelector(".cthide-btn"));
    expect(isHidden(win, cardFor(doc, "111"))).toBe(true);
    await settle();
    expect(isHidden(win, cardFor(doc, "111"))).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  test("a hidden card stays hidden after the framework re-renders it", async () => {
    const storage = createStorage({ "hidden:111": entry() });
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS), storage });
    cardFor(doc, "111").outerHTML = cardHtml({ itemId: "111" });
    expect(isHidden(win, cardFor(doc, "111"))).toBe(true);
  });

  test("rules apply only in grid mode", async () => {
    const storage = createStorage({ "hidden:111": entry() });
    const { win, doc } = await bootContent({
      url: "https://www.ctbids.com/watching",
      html: gridHtml(ITEMS),
      storage,
    });
    expect(isHidden(win, cardFor(doc, "111"))).toBe(false);
  });

  test("re-attaches the rules stylesheet if the page removes it", async () => {
    const storage = createStorage({ "hidden:111": entry() });
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS), storage });
    doc.getElementById("cthide-rules").remove();
    await settle();
    expect(doc.getElementById("cthide-rules")).not.toBeNull();
    expect(isHidden(win, cardFor(doc, "111"))).toBe(true);
  });
});

describe("startup", () => {
  test("hides stored items and prunes expired and malformed ones", async () => {
    const storage = createStorage({
      "hidden:111": entry(),
      "hidden:222": entry({ hiddenAt: Date.now() - CTHIDE.TTL_MS - 1 }),
      "hidden:333": { title: "malformed" },
      "unrelated": 1,
    });
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS), storage });

    expect(isHidden(win, cardFor(doc, "111"))).toBe(true);
    expect(isHidden(win, cardFor(doc, "222"))).toBe(false);
    expect(isHidden(win, cardFor(doc, "333"))).toBe(false);
    expect(Object.keys(storage.data).sort()).toEqual(["hidden:111", "unrelated"]);
  });

  test("prunes on non-grid pages too", async () => {
    const storage = createStorage({ "hidden:1": entry({ hiddenAt: 0 }) });
    await bootContent({ url: "https://www.ctbids.com/my-account", storage });
    expect(storage.data).toEqual({});
  });

  test("hides the grid with cthide-pending until storage loads", async () => {
    const storage = createStorage({ "hidden:111": entry() });
    const read = deferred();
    storage.local.get.mockReturnValueOnce(read.promise);
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS), storage, withCss: true });

    expect(doc.documentElement.classList.contains("cthide-pending")).toBe(true);
    expect(style(win, cardFor(doc, "222")).visibility).toBe("hidden");

    read.resolve(structuredClone(storage.data));
    await settle();
    expect(doc.documentElement.classList.contains("cthide-pending")).toBe(false);
    expect(style(win, cardFor(doc, "222")).visibility).not.toBe("hidden");
    expect(isHidden(win, cardFor(doc, "111"))).toBe(true);
  });

  test("does not add cthide-pending on non-grid pages", async () => {
    const storage = createStorage();
    storage.local.get.mockReturnValueOnce(deferred().promise);
    const { doc } = await bootContent({ url: "https://www.ctbids.com/watching", storage });
    expect(doc.documentElement.classList.contains("cthide-pending")).toBe(false);
  });

  test("removes cthide-pending when the storage read fails", async () => {
    const storage = createStorage();
    storage.local.get.mockRejectedValueOnce(new Error("broken"));
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS), storage, wait: false });
    vi.spyOn(win.console, "error").mockImplementation(() => {});
    await settle();
    expect(doc.documentElement.classList.contains("cthide-pending")).toBe(false);
    expect(doc.querySelectorAll(".cthide-btn")).toHaveLength(3);
  });

  test("failsafe removes cthide-pending if the storage read hangs", async () => {
    vi.useFakeTimers();
    const storage = createStorage();
    storage.local.get.mockReturnValueOnce(deferred().promise);
    const { doc } = await bootContent({ html: gridHtml(ITEMS), storage, wait: false });

    await vi.advanceTimersByTimeAsync(CTHIDE.PENDING_FAILSAFE_MS - 1);
    expect(doc.documentElement.classList.contains("cthide-pending")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(doc.documentElement.classList.contains("cthide-pending")).toBe(false);
  });

  test("an unhide that arrives during the initial read wins", async () => {
    const storage = createStorage({ "hidden:111": entry() });
    const stale = structuredClone(storage.data);
    const read = deferred();
    storage.local.get.mockReturnValueOnce(read.promise);
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS), storage });

    await storage.local.remove("hidden:111"); // e.g. popup unhide
    await settle();
    read.resolve(stale);
    await settle();
    expect(isHidden(win, cardFor(doc, "111"))).toBe(false);
  });
});

describe("live sync", () => {
  test("hides and unhides when storage changes elsewhere", async () => {
    const storage = createStorage();
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS), storage });

    await storage.local.set({ "hidden:222": entry() });
    await settle();
    expect(isHidden(win, cardFor(doc, "222"))).toBe(true);

    await storage.local.remove("hidden:222");
    await settle();
    expect(isHidden(win, cardFor(doc, "222"))).toBe(false);
  });

  test("ignores expired values written by others", async () => {
    const storage = createStorage();
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS), storage });
    await storage.local.set({ "hidden:222": entry({ hiddenAt: 0 }) });
    await settle();
    expect(isHidden(win, cardFor(doc, "222"))).toBe(false);
  });

  test("a hide in one tab hides the card in another tab", async () => {
    const storage = createStorage();
    const tabA = await bootContent({ html: gridHtml(ITEMS), storage });
    const tabB = await bootContent({ html: gridHtml(ITEMS), storage });

    click(tabA.win, cardFor(tabA.doc, "333").querySelector(".cthide-btn"));
    await settle();
    expect(isHidden(tabB.win, cardFor(tabB.doc, "333"))).toBe(true);
  });
});

describe("navigation without reload", () => {
  test("leaving a grid page drops the grid class and its hiding", async () => {
    const storage = createStorage({ "hidden:111": entry() });
    const { win, doc } = await bootContent({ html: gridHtml(ITEMS), storage });
    expect(isHidden(win, cardFor(doc, "111"))).toBe(true);

    win.history.pushState({}, "", "/watching");
    doc.body.appendChild(doc.createElement("div")); // route change mutates the DOM
    await settle();
    expect(doc.documentElement.classList.contains("cthide-grid")).toBe(false);
    expect(isHidden(win, cardFor(doc, "111"))).toBe(false);
  });

  test("popstate re-checks the mode", async () => {
    const { win, doc } = await bootContent({ url: "https://www.ctbids.com/watching" });
    win.history.pushState({}, "", "/category/Jewelry");
    win.dispatchEvent(new win.PopStateEvent("popstate"));
    expect(doc.documentElement.classList.contains("cthide-grid")).toBe(true);
  });
});

describe("detail page banner", () => {
  const ttlDays = CTHIDE.TTL_MS / CTHIDE.DAY_MS;

  test("shows for a hidden item", async () => {
    const storage = createStorage({ "hidden:111": entry() });
    const { doc } = await bootContent({ url: DETAIL_URL, storage });
    const banner = doc.getElementById("cthide-banner");
    expect(banner.textContent).toContain(`You hid this item today. Expires in ${ttlDays} days.`);
  });

  test("shows days ago for older hides", async () => {
    const storage = createStorage({
      "hidden:111": entry({ hiddenAt: Date.now() - 3 * CTHIDE.DAY_MS - 1000 }),
    });
    const { doc } = await bootContent({ url: DETAIL_URL, storage });
    expect(doc.getElementById("cthide-banner").textContent).toContain(
      `You hid this item 3 days ago. Expires in ${ttlDays - 3} days.`
    );
  });

  test("also shows on search-result detail pages", async () => {
    const storage = createStorage({ "hidden:111": entry() });
    const { doc } = await bootContent({
      url: "https://www.ctbids.com/view-more-items/48813/item/111",
      storage,
    });
    expect(doc.getElementById("cthide-banner")).not.toBeNull();
  });

  test("is absent for items that are not hidden", async () => {
    const storage = createStorage({ "hidden:999": entry() });
    const { doc } = await bootContent({ url: DETAIL_URL, storage });
    expect(doc.getElementById("cthide-banner")).toBeNull();
  });

  test("Unhide removes the key and the banner", async () => {
    const storage = createStorage({ "hidden:111": entry() });
    const { win, doc } = await bootContent({ url: DETAIL_URL, storage });
    click(win, doc.querySelector(".cthide-banner-unhide"));
    await settle();
    expect(storage.data["hidden:111"]).toBeUndefined();
    expect(doc.getElementById("cthide-banner")).toBeNull();
  });

  test("dismiss removes the banner for this page view only", async () => {
    const storage = createStorage({ "hidden:111": entry() });
    const { win, doc } = await bootContent({ url: DETAIL_URL, storage });
    click(win, doc.querySelector(".cthide-banner-close"));
    await settle();
    expect(doc.getElementById("cthide-banner")).toBeNull();
    expect(storage.data["hidden:111"]).toBeDefined();

    win.history.pushState({}, "", "/estate-sale/48813/item/111/Lamp/again");
    doc.body.appendChild(doc.createElement("div"));
    await settle();
    expect(doc.getElementById("cthide-banner")).not.toBeNull();
  });

  test("appears when the item is hidden from another tab", async () => {
    const storage = createStorage();
    const { doc } = await bootContent({ url: DETAIL_URL, storage });
    await storage.local.set({ "hidden:111": entry() });
    await settle();
    expect(doc.getElementById("cthide-banner")).not.toBeNull();
  });

  test("goes away when navigating to a grid", async () => {
    const storage = createStorage({ "hidden:111": entry() });
    const { win, doc } = await bootContent({ url: DETAIL_URL, storage });
    win.history.pushState({}, "", "/estate-sale/48813");
    doc.body.appendChild(doc.createElement("div"));
    await settle();
    expect(doc.getElementById("cthide-banner")).toBeNull();
  });
});
