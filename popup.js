// Injected into the page. Must be self-contained (no closures over outer scope).
function extractImages() {
  const MIN_SIZE = 100; // px, either dimension below this is treated as icon/logo
  const NOISE_PATTERNS = /(logo|icon|sprite|favicon|avatar|badge|pixel|tracking|spinner|loader)/i;
  const LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-srcset", "data-original-src"];

  function isInNoiseLandmark(el) {
    let node = el;
    while (node) {
      const tag = node.tagName;
      const role = node.getAttribute && node.getAttribute("role");
      if (
        tag === "HEADER" || tag === "FOOTER" || tag === "NAV" ||
        role === "banner" || role === "navigation" || role === "contentinfo"
      ) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function absolute(url) {
    try {
      return new URL(url, document.baseURI).href;
    } catch (e) {
      return null;
    }
  }

  function pickFromSrcset(srcset) {
    if (!srcset) return null;
    const candidates = srcset.split(",").map((s) => s.trim().split(/\s+/));
    let best = null;
    let bestWidth = -1;
    for (const [url, size] of candidates) {
      const w = size ? parseInt(size, 10) || 0 : 0;
      if (w >= bestWidth) {
        bestWidth = w;
        best = url;
      }
    }
    return best;
  }

  const found = new Map(); // absolute url -> record

  function add(url, width, height, el) {
    const abs = absolute(url);
    if (!abs || abs.startsWith("data:")) return;
    if (NOISE_PATTERNS.test(abs)) return;
    if (el && isInNoiseLandmark(el)) return;
    if (width && height && (width < MIN_SIZE || height < MIN_SIZE)) return;

    const existing = found.get(abs);
    const area = (width || 0) * (height || 0);
    if (!existing || area > existing.area) {
      found.set(abs, { url: abs, width: width || 0, height: height || 0, area });
    }
  }

  // 1. <img> elements, including lazy-loaded variants
  document.querySelectorAll("img").forEach((img) => {
    const rect = img.getBoundingClientRect();
    let src = img.currentSrc || img.src || "";
    for (const attr of LAZY_ATTRS) {
      const v = img.getAttribute(attr);
      if (v && !src) src = attr.includes("srcset") ? pickFromSrcset(v) : v;
    }
    if (img.srcset) {
      const best = pickFromSrcset(img.srcset);
      if (best) src = best;
    }
    if (!src) return;
    const w = img.naturalWidth || rect.width;
    const h = img.naturalHeight || rect.height;
    add(src, w, h, img);
  });

  // 2. CSS background-image on any element
  const all = document.querySelectorAll("*");
  const urlRe = /url\(["']?([^"')]+)["']?\)/g;
  for (const el of all) {
    const style = getComputedStyle(el);
    const bg = style.backgroundImage;
    if (!bg || bg === "none") continue;
    let match;
    urlRe.lastIndex = 0;
    while ((match = urlRe.exec(bg))) {
      const rect = el.getBoundingClientRect();
      add(match[1], rect.width, rect.height, el);
    }
  }

  return Array.from(found.values()).sort((a, b) => b.area - a.area);
}

const statusEl = document.getElementById("status");
const gridEl = document.getElementById("grid");
const toolbarEl = document.getElementById("toolbar");
const countEl = document.getElementById("count");
const rescanBtn = document.getElementById("rescan");
const downloadAllBtn = document.getElementById("downloadAll");

let currentItems = [];
let currentHost = "page";

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100);
}

function filenameFor(item, index) {
  let base;
  try {
    base = decodeURIComponent(new URL(item.url).pathname.split("/").pop() || "");
  } catch (e) {
    base = "";
  }
  if (!base || !/\.[a-z0-9]{2,5}$/i.test(base)) {
    base = `image-${index + 1}.jpg`;
  }
  return `VytahniTo/${sanitizeFilename(currentHost)}/${sanitizeFilename(String(index + 1).padStart(2, "0") + "_" + base)}`;
}

function downloadItem(item, index) {
  chrome.downloads.download({ url: item.url, filename: filenameFor(item, index) });
}

function render(items) {
  currentItems = items;
  gridEl.innerHTML = "";
  if (items.length === 0) {
    statusEl.hidden = false;
    statusEl.textContent = "Na stránce nebyly nalezeny žádné vhodné obrázky.";
    toolbarEl.hidden = true;
    return;
  }
  statusEl.hidden = true;
  toolbarEl.hidden = false;
  countEl.textContent = `Nalezeno: ${items.length}`;

  items.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "item";

    const img = document.createElement("img");
    img.src = item.url;
    img.loading = "lazy";
    img.draggable = true;
    div.appendChild(img);

    const actions = document.createElement("div");
    actions.className = "actions";

    const openBtn = document.createElement("button");
    openBtn.textContent = "↗";
    openBtn.title = "Otevřít v nové záložce";
    openBtn.addEventListener("click", () => chrome.tabs.create({ url: item.url }));
    actions.appendChild(openBtn);

    const dlBtn = document.createElement("button");
    dlBtn.textContent = "⭳";
    dlBtn.title = "Stáhnout";
    dlBtn.addEventListener("click", () => downloadItem(item, index));
    actions.appendChild(dlBtn);

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "⧉";
    copyBtn.title = "Kopírovat URL";
    copyBtn.addEventListener("click", () => navigator.clipboard.writeText(item.url));
    actions.appendChild(copyBtn);

    div.appendChild(actions);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = item.width && item.height ? `${Math.round(item.width)}×${Math.round(item.height)}` : "";
    div.appendChild(meta);

    gridEl.appendChild(div);
  });
}

async function scan() {
  statusEl.hidden = false;
  statusEl.textContent = "Skenuji stránku…";
  gridEl.innerHTML = "";
  toolbarEl.hidden = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    statusEl.textContent = "Nelze najít záložku.";
    return;
  }
  try {
    currentHost = new URL(tab.url).hostname || "page";
  } catch (e) {
    currentHost = "page";
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractImages,
    });
    const merged = new Map();
    for (const frameResult of results) {
      const items = frameResult.result || [];
      for (const item of items) {
        const existing = merged.get(item.url);
        if (!existing || item.area > existing.area) merged.set(item.url, item);
      }
    }
    const items = Array.from(merged.values()).sort((a, b) => b.area - a.area);
    render(items);
  } catch (e) {
    statusEl.textContent = "Na této stránce nelze skenovat.";
  }
}

rescanBtn.addEventListener("click", scan);
downloadAllBtn.addEventListener("click", () => {
  currentItems.forEach((item, index) => {
    setTimeout(() => downloadItem(item, index), index * 150);
  });
});

scan();
