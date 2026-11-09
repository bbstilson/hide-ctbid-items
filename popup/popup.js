// Toolbar popup. Depends on CTHIDE from common.js.

const listEl = document.getElementById("list");
const countEl = document.getElementById("count");
const clearBtn = document.getElementById("clear");
const emptyEl = document.getElementById("empty");

const CLEAR_CONFIRM_MS = 3000;

let items = [];
let armed = false;
let armTimer = null;

/** Live entries, newest first. Expired ones are skipped but not pruned. */
async function load() {
  const all = await browser.storage.local.get(null);
  const { live } = CTHIDE.partition(all);
  return Array.from(live, ([itemId, entry]) => ({ itemId, ...entry })).sort(
    (a, b) => b.hiddenAt - a.hiddenAt
  );
}

function refresh() {
  return load()
    .then(render)
    .catch((err) => console.error("cthide: popup load failed", err));
}

function render(next) {
  items = next;
  const scroll = listEl.scrollTop;
  listEl.replaceChildren(...items.map(renderRow));
  listEl.scrollTop = scroll;
  updateHeader();
}

function updateHeader() {
  countEl.textContent = String(items.length);
  emptyEl.hidden = items.length > 0;
  listEl.hidden = items.length === 0;
  updateClearButton();
}

function renderRow(item) {
  const li = document.createElement("li");
  li.className = "row";

  let title;
  if (isSafeUrl(item.url)) {
    title = document.createElement("button");
    title.type = "button";
    title.className = "title link";
    title.addEventListener("click", async () => {
      try {
        await browser.tabs.create({ url: item.url });
        window.close();
      } catch (err) {
        console.error("cthide: failed to open item", err);
      }
    });
  } else {
    title = document.createElement("span");
    title.className = "title";
  }
  title.textContent = item.title || `Item ${item.itemId}`;

  const left = document.createElement("span");
  left.className = "left";
  left.textContent = `${CTHIDE.plural(CTHIDE.daysLeft(item), "day")} left`;

  const unhideBtn = document.createElement("button");
  unhideBtn.type = "button";
  unhideBtn.className = "unhide";
  unhideBtn.textContent = "Unhide";
  unhideBtn.addEventListener("click", () => unhide(item.itemId, li));

  const info = document.createElement("div");
  info.className = "info";
  info.append(title, left);

  li.append(info, unhideBtn);
  return li;
}

/** Only open item URLs that point at ctbids.com. The URL comes from page content. */
function isSafeUrl(url) {
  try {
    const u = new URL(url);
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      (u.hostname === "ctbids.com" || u.hostname.endsWith(".ctbids.com"))
    );
  } catch {
    return false;
  }
}

async function unhide(itemId, li) {
  li.remove();
  items = items.filter((i) => i.itemId !== itemId);
  updateHeader();
  try {
    await browser.storage.local.remove(CTHIDE.keyFor(itemId));
  } catch (err) {
    console.error("cthide: unhide failed", err);
    refresh();
  }
}

function updateClearButton() {
  clearBtn.textContent = armed ? `Confirm clear (${items.length})` : "Clear all";
  clearBtn.classList.toggle("armed", armed);
  clearBtn.disabled = !armed && items.length === 0;
}

function disarm() {
  clearTimeout(armTimer);
  armTimer = null;
  armed = false;
  updateClearButton();
}

// Two clicks, because window.confirm() is unreliable in Firefox popups.
async function onClearClick() {
  if (!armed) {
    armed = true;
    armTimer = setTimeout(disarm, CLEAR_CONFIRM_MS);
    updateClearButton();
    return;
  }
  disarm();
  try {
    const all = await browser.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(CTHIDE.KEY_PREFIX));
    if (keys.length) await browser.storage.local.remove(keys);
  } catch (err) {
    console.error("cthide: clear all failed", err);
  }
  refresh();
}

clearBtn.addEventListener("click", onClearClick);

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.keys(changes).some((k) => k.startsWith(CTHIDE.KEY_PREFIX))) refresh();
});

refresh();
