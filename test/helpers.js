// Test harness: loads the extension's classic scripts into a fresh happy-dom
// window per test, with a fake `browser` API backed by in-memory storage.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { vi } from "vitest";
import { Window } from "happy-dom";
import * as HappyDOMSymbol from "happy-dom/lib/PropertySymbol.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

export const SRC = {
  common: read("common.js"),
  content: read("content.js"),
  contentCss: read("content.css"),
  popupHtml: read("popup/popup.html"),
  popup: read("popup/popup.js"),
};

/** CTHIDE evaluated on its own, for pure helper tests and shared constants. */
export const CTHIDE = vm.runInNewContext(`${SRC.common};CTHIDE`);

const openWindows = new Set();

/** Closes every window created by createWindow. Call from afterEach. */
export async function closeAllWindows() {
  for (const win of openWindows) await win.happyDOM.close();
  openWindows.clear();
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/**
 * In-memory stand-in for browser.storage.local plus storage.onChanged.
 * One instance can back several windows to simulate several tabs.
 * Methods are vi.fn, so tests can inject failures with mockRejectedValueOnce.
 */
export function createStorage(initial = {}) {
  const data = clone(initial);
  const listeners = new Set();

  // Firefox fires onChanged asynchronously, after the write resolves.
  const emit = (changes) => {
    if (!Object.keys(changes).length) return;
    setTimeout(() => {
      for (const fn of listeners) fn(clone(changes), "local");
    }, 0);
  };

  const local = {
    get: vi.fn(async (keys) => {
      if (keys === null || keys === undefined) return clone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, clone(data[k])]));
    }),
    set: vi.fn(async (items) => {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
        data[k] = clone(v);
      }
      emit(changes);
    }),
    remove: vi.fn(async (keys) => {
      const changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (k in data) {
          changes[k] = { oldValue: clone(data[k]) };
          delete data[k];
        }
      }
      emit(changes);
    }),
  };

  return {
    data,
    local,
    onChanged: {
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
      hasListener: (fn) => listeners.has(fn),
    },
  };
}

export function createBrowser(storage = createStorage()) {
  return {
    storage: { local: storage.local, onChanged: storage.onChanged },
    tabs: { create: vi.fn(async () => ({})) },
  };
}

/**
 * New happy-dom window. Timers and requestAnimationFrame delegate to Node's
 * globals at call time, so vi.useFakeTimers() controls them.
 */
export function createWindow(url, browser) {
  const win = new Window({
    url,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      navigator: { userAgent: "test" },
    },
  });
  openWindows.add(win);
  win.browser = browser;
  win.setTimeout = (...a) => globalThis.setTimeout(...a);
  win.clearTimeout = (...a) => globalThis.clearTimeout(...a);
  win.requestAnimationFrame = (cb) => globalThis.setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id) => globalThis.clearTimeout(id);
  return win;
}

/**
 * Runs scripts the way Firefox does for one content_scripts entry: they share
 * one global lexical scope. A single eval reproduces that.
 */
export function runScripts(win, ...sources) {
  win.eval(sources.join("\n;\n"));
}

/** Lets timers, rAF scans, MutationObserver callbacks and promises settle. */
export async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(20);
    else await new Promise((r) => setTimeout(r, 5));
  }
}

/** Card markup as observed on ctbids.com (see SPEC.md "Site markup"). */
export function cardHtml({ saleId = "48813", itemId, title = `Title ${itemId}`, href } = {}) {
  const link =
    href === null
      ? ""
      : `<a class="image-container d-flex clickable" href="${
          href ?? `/estate-sale/${saleId}/item/${itemId}/Some-Slug`
        }"><img alt="${title}" class="items-image"></a>`;
  return `
    <div id="cardid" class="listitem col">
      <div class="itemcard">
        <div class="borderview"><div>
          ${link}
          <div class="m-3">
            <div class="itemcard-head">${title}</div>
            <button class="watch">eye</button>
            <button class="bid">Bid Now</button>
          </div>
        </div></div>
      </div>
    </div>`;
}

export function gridHtml(cards) {
  return `<div class="row" id="grid">${cards.map(cardHtml).join("")}</div>`;
}

export function entry(overrides = {}) {
  return {
    hiddenAt: Date.now(),
    saleId: "48813",
    title: "Some item",
    url: "https://www.ctbids.com/estate-sale/48813/item/1/x",
    ...overrides,
  };
}

/**
 * Boots the content script on a page.
 * - `html`: body markup present before the script runs. Omit it to simulate
 *   document_start with an empty page.
 * - `withCss`: also apply content.css, for the pending-class tests.
 */
export async function bootContent({
  url = "https://www.ctbids.com/estate-sale/48813",
  html = "",
  storage = createStorage(),
  withCss = false,
  wait = true,
} = {}) {
  const browser = createBrowser(storage);
  const win = createWindow(url, browser);
  win.document.body.innerHTML = html;
  if (withCss) {
    const css = win.document.createElement("style");
    css.textContent = SRC.contentCss;
    win.document.head.appendChild(css);
  }
  runScripts(win, SRC.common, SRC.content);
  if (wait) await settle();
  return { win, doc: win.document, browser, storage };
}

/** Boots the popup page with its markup (scripts and stylesheet stripped). */
export async function bootPopup({ storage = createStorage(), wait = true } = {}) {
  const browser = createBrowser(storage);
  const win = createWindow("https://extension.invalid/popup/popup.html", browser);
  const body = SRC.popupHtml
    .match(/<body>([\s\S]*)<\/body>/)[1]
    .replace(/<script[\s\S]*?<\/script>/g, "");
  win.document.body.innerHTML = body;
  win.close = vi.fn();
  runScripts(win, SRC.common, SRC.popup);
  if (wait) await settle();
  return { win, doc: win.document, browser, storage };
}

/**
 * getComputedStyle that is never stale. happy-dom caches computed styles per
 * element and does not invalidate them when a class changes on <html>, which
 * content.js does for cthide-grid and cthide-pending. Clear the element's and
 * its ancestors' caches before reading. Uses a happy-dom internal symbol;
 * revisit if a happy-dom upgrade breaks it.
 */
export function style(win, el) {
  for (let node = el; node; node = node.parentNode) node[HappyDOMSymbol.clearCache]();
  return win.getComputedStyle(el);
}

export function isHidden(win, el) {
  return style(win, el).display === "none";
}

export function cardFor(doc, itemId) {
  return doc
    .querySelector(`.listitem a.image-container[href*="/item/${itemId}/"]`)
    ?.closest(".listitem");
}

export function click(win, el, init = {}) {
  const ev = new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
}
