// Content script for all ctbids.com pages. Depends on CTHIDE from common.js.

let currentMode = "none"; // "grid" | "detail" | "none"
let currentPath = null;
const hidden = new Map(); // Map<itemId, entry>
let styleEl = null; // <style id="cthide-rules">
let bannerEl = null; // <div id="cthide-banner">
let bannerDismissedFor = null; // item ID dismissed on this page view
let scanQueued = false;

// Startup read/onChanged race: changes that arrive while the initial read is
// in flight win over the read result for the same item.
let loading = true;
const touchedDuringLoad = new Set();

const BUTTON_EVENTS = ["pointerdown", "mousedown", "mouseup", "click", "auxclick"];
const SVG_NS = "http://www.w3.org/2000/svg";

init();

async function init() {
  const root = document.documentElement;
  if (CTHIDE.modeFor(location.pathname) === "grid") root.classList.add("cthide-pending");

  styleEl = document.createElement("style");
  styleEl.id = "cthide-rules";
  root.appendChild(styleEl);

  browser.storage.onChanged.addListener(onStorageChanged);
  for (const type of BUTTON_EVENTS) window.addEventListener(type, onButtonEvent, true);

  // Failsafe: never leave the grid invisible if the storage read hangs.
  const failsafe = setTimeout(
    () => root.classList.remove("cthide-pending"),
    CTHIDE.PENDING_FAILSAFE_MS
  );

  try {
    const all = await browser.storage.local.get(null);
    const { live, deadKeys } = CTHIDE.partition(all);
    for (const [id, entry] of live) {
      if (!touchedDuringLoad.has(id)) hidden.set(id, entry);
    }
    renderRules();
    if (deadKeys.length) {
      browser.storage.local.remove(deadKeys).catch((err) => {
        console.error("cthide: prune failed", err);
      });
    }
  } catch (err) {
    console.error("cthide: storage read failed", err);
  } finally {
    loading = false;
    touchedDuringLoad.clear();
    clearTimeout(failsafe);
    root.classList.remove("cthide-pending");
  }

  new MutationObserver(queueScan).observe(root, { childList: true, subtree: true });
  window.addEventListener("popstate", scan);
  scan();
}

// --- Mode ---

function checkMode() {
  const path = location.pathname;
  if (path === currentPath) return;
  currentPath = path;

  const mode = CTHIDE.modeFor(path);
  document.documentElement.classList.toggle("cthide-grid", mode === "grid");

  // A new path means a new page view, even between two detail pages.
  removeBanner();
  bannerDismissedFor = null;
  currentMode = mode;
  if (mode === "detail") renderBanner();
}

// --- Hide rules ---

function ensureStyleAttached() {
  if (styleEl && !styleEl.isConnected) document.documentElement.appendChild(styleEl);
}

function renderRules() {
  styleEl.textContent = Array.from(hidden.keys(), ruleFor).join("\n");
  ensureStyleAttached();
}

function ruleFor(itemId) {
  // IDs are validated as digits only, so interpolation is safe.
  const s = CTHIDE.SEL;
  return (
    `html.cthide-grid ${s.card}:has(${s.link}:is(` +
    `[href*="/item/${itemId}/"], [href$="/item/${itemId}"], [href*="/item/${itemId}?"]` +
    `)) { display: none !important; }`
  );
}

// --- Scanning ---

function queueScan() {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    scan();
  });
}

function scan() {
  checkMode();
  ensureStyleAttached();
  if (currentMode === "grid") addButtons();
  else if (currentMode === "detail") renderBanner();
}

function itemIdFromCard(card) {
  const link = card.querySelector(CTHIDE.SEL.link);
  const m = link && CTHIDE.RE.itemHref.exec(link.getAttribute("href"));
  return m ? m[2] : null;
}

function addButtons() {
  for (const host of document.querySelectorAll(CTHIDE.SEL.host)) {
    const id = itemIdFromCard(host.parentElement);
    const existing = host.querySelector(":scope > .cthide-btn");
    if (!id) {
      existing?.remove();
      continue;
    }
    if (existing) {
      // The framework may reuse a card node for a different item.
      if (existing.dataset.cthideId !== id) existing.dataset.cthideId = id;
      continue;
    }
    host.appendChild(makeButton(id));
  }
}

function makeButton(itemId) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cthide-btn";
  btn.dataset.cthideId = itemId;
  btn.setAttribute("aria-label", "Hide item");
  btn.title = "Hide item";
  btn.appendChild(makeXIcon(24));
  return btn;
}

function makeXIcon(size) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M6 6L18 18M18 6L6 18");
  svg.appendChild(path);
  return svg;
}

// --- Click handling ---

// Registered on window in the capture phase, so it runs before any site
// handler on the card and the card never opens from the button.
function onButtonEvent(e) {
  const btn = e.target instanceof Element ? e.target.closest(".cthide-btn") : null;
  if (!btn) return;
  e.preventDefault();
  e.stopImmediatePropagation();

  if (e.type !== "click") return;
  if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.metaKey || e.altKey) return;
  if (currentMode !== "grid") return;
  // Read the ID from the card's current link, not the button's data attribute:
  // the framework may have pointed a reused card at another item since the last scan.
  const card = btn.closest(CTHIDE.SEL.card);
  const id = card && itemIdFromCard(card);
  if (id) hideFromCard(btn, id);
}

async function hideFromCard(btn, itemId) {
  const card = btn.closest(CTHIDE.SEL.card);
  if (!card) return;

  const prev = hidden.get(itemId);
  const entry = { hiddenAt: Date.now(), ...readCardInfo(card, itemId) };
  hidden.set(itemId, entry);
  renderRules();
  focusNextButton(card);

  try {
    await browser.storage.local.set({ [CTHIDE.keyFor(itemId)]: entry });
  } catch (err) {
    // Roll back only if nothing newer replaced our entry meanwhile.
    if (hidden.get(itemId) === entry) {
      if (prev) hidden.set(itemId, prev);
      else hidden.delete(itemId);
      renderRules();
    }
    console.error("cthide: failed to save hidden item", err);
  }
}

function readCardInfo(card, itemId) {
  const s = CTHIDE.SEL;
  const href = card.querySelector(s.link)?.getAttribute("href") || "";
  const m = CTHIDE.RE.itemHref.exec(href);

  const title =
    card.querySelector(s.title)?.textContent.trim() ||
    card.querySelector(s.img)?.getAttribute("alt")?.trim() ||
    `Item ${itemId}`;

  let url = "";
  try {
    url = new URL(href, location.origin).href;
  } catch {
    // Leave empty; the popup shows the title as plain text.
  }

  return { saleId: m ? m[1] : "", title: title.slice(0, CTHIDE.TITLE_MAX), url };
}

function focusNextButton(card) {
  for (let el = card.nextElementSibling; el; el = el.nextElementSibling) {
    if (!el.matches(CTHIDE.SEL.card) || !el.checkVisibility()) continue;
    const btn = el.querySelector(".cthide-btn");
    if (btn) {
      btn.focus();
      return;
    }
  }
}

// --- Live sync ---

function onStorageChanged(changes, area) {
  if (area !== "local") return;
  let changed = false;
  for (const [key, change] of Object.entries(changes)) {
    const id = CTHIDE.itemIdFromKey(key);
    if (id === null) continue;
    if (loading) touchedDuringLoad.add(id);
    const entry = CTHIDE.parseEntry(change.newValue);
    if (entry && !CTHIDE.isExpired(entry)) hidden.set(id, entry);
    else hidden.delete(id);
    changed = true;
  }
  if (!changed) return;
  renderRules();
  if (currentMode === "detail") renderBanner();
}

// --- Detail page banner ---

function detailItemId() {
  const m = CTHIDE.RE.detailPath.exec(location.pathname);
  return m ? m[2] : null;
}

function renderBanner() {
  const id = currentMode === "detail" ? detailItemId() : null;
  const entry = id && hidden.get(id);
  if (!entry || CTHIDE.isExpired(entry) || bannerDismissedFor === id) {
    removeBanner();
    return;
  }
  if (!document.body) return; // Retried on the next observer tick.

  if (!bannerEl || bannerEl.dataset.cthideId !== id) {
    removeBanner();
    bannerEl = buildBanner(id);
  }

  const n = CTHIDE.daysAgo(entry);
  const ago = n === 0 ? "today" : `${CTHIDE.plural(n, "day")} ago`;
  const text = `You hid this item ${ago}. Expires in ${CTHIDE.plural(CTHIDE.daysLeft(entry), "day")}.`;
  const textEl = bannerEl.querySelector(".cthide-banner-text");
  // Only write when changed: scan() runs this every frame with DOM churn.
  if (textEl.textContent !== text) textEl.textContent = text;
  if (!bannerEl.isConnected) document.body.appendChild(bannerEl);
}

function buildBanner(itemId) {
  const el = document.createElement("div");
  el.id = "cthide-banner";
  el.dataset.cthideId = itemId;
  el.setAttribute("role", "status");

  const text = document.createElement("span");
  text.className = "cthide-banner-text";

  const unhide = document.createElement("button");
  unhide.type = "button";
  unhide.className = "cthide-banner-unhide";
  unhide.textContent = "Unhide";
  unhide.addEventListener("click", () => {
    browser.storage.local.remove(CTHIDE.keyFor(itemId)).catch((err) => {
      console.error("cthide: unhide failed", err);
    });
  });

  const close = document.createElement("button");
  close.type = "button";
  close.className = "cthide-banner-close";
  close.setAttribute("aria-label", "Dismiss");
  close.title = "Dismiss";
  close.appendChild(makeXIcon(18));
  close.addEventListener("click", () => {
    bannerDismissedFor = itemId;
    removeBanner();
  });

  el.append(text, unhide, close);
  return el;
}

function removeBanner() {
  bannerEl?.remove();
  bannerEl = null;
}
