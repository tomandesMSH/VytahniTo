// Injected into the page. Must be self-contained (no closures over outer scope).
function extractImages(opts) {
  const MIN_SIZE = opts.minImageSize; // px, either dimension below this is treated as icon/logo
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
    if (opts.skipNoise && NOISE_PATTERNS.test(abs)) return;
    if (opts.skipNoise && el && isInNoiseLandmark(el)) return;
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

// Injected into the page. Must be self-contained (no closures over outer scope).
function extractVideos() {
  const MEDIA_LINK = /\.(mp4|m4v|webm|mov|mkv|ogv|m3u8|mpd|mp3|m4a|ogg|opus|wav|flac)(?:$|[?#])/i;
  const found = new Map();
  let blobPlayers = 0;

  function add(url, info) {
    if (!url) return;
    if (url.startsWith("blob:") || url.startsWith("mediasource:")) {
      blobPlayers++;
      return;
    }
    let abs;
    try {
      abs = new URL(url, document.baseURI).href;
    } catch (e) {
      return;
    }
    if (!/^https?:/.test(abs)) return;
    found.set(abs, { ...found.get(abs), url: abs, ...info });
  }

  document.querySelectorAll("video, audio").forEach((v) => {
    const info = {
      width: v.videoWidth || 0,
      height: v.videoHeight || 0,
      duration: isFinite(v.duration) ? v.duration : 0,
      poster: v.poster || "",
      audioOnly: v.tagName === "AUDIO",
    };
    add(v.currentSrc || v.src, info);
    v.querySelectorAll("source[src]").forEach((s) => add(s.getAttribute("src"), info));
  });

  const metaSel = [
    'meta[property="og:video"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video:secure_url"]',
    'meta[name="twitter:player:stream"]',
  ].join(",");
  document.querySelectorAll(metaSel).forEach((m) => add(m.content, {}));

  document.querySelectorAll("a[href]").forEach((a) => {
    if (MEDIA_LINK.test(a.href)) add(a.href, {});
  });

  return { items: Array.from(found.values()), blobPlayers };
}

const statusEl = document.getElementById("status");
const gridEl = document.getElementById("grid");
const toolbarEl = document.getElementById("toolbar");
const countEl = document.getElementById("count");
const rescanBtn = document.getElementById("rescan");
const downloadAllBtn = document.getElementById("downloadAll");

let currentItems = [];
let currentHost = "page";
let currentTitle = "";
let settings = { ...DEFAULT_SETTINGS };

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
  return downloadPath(settings, currentHost, currentTitle, String(index + 1).padStart(2, "0") + "_" + base);
}

function downloadItem(item, index, askWhere) {
  chrome.downloads.download({
    url: item.url,
    filename: filenameFor(item, index),
    conflictAction: "uniquify",
    saveAs: !!askWhere,
  });
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
    dlBtn.addEventListener("click", () => downloadItem(item, index, settings.saveAs));
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

// ---- Videos ----

const vidStatusEl = document.getElementById("vidStatus");
const vidListEl = document.getElementById("vidList");
const imgCountEl = document.getElementById("imgCount");
const vidCountEl = document.getElementById("vidCount");
const vidNoticeEl = document.getElementById("vidNotice");
const ytCmdEl = document.getElementById("ytCmd");

document.getElementById("copyYtCmd").addEventListener("click", () => navigator.clipboard.writeText(ytCmdEl.textContent));

let currentTabId = null;
let currentUrl = "";
let domVideos = [];
let blobPlayers = 0;
let videoEntries = [];
let jobs = {};
const playlists = new Map(); // hls url -> Promise<parsed playlist | null>
const selectedVariant = new Map(); // entry url -> variant index
const jobViews = new Map(); // entry url -> update() for its progress UI

const EXT_BY_MIME = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/ogg": "ogv",
  "video/x-flv": "flv",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/wav": "wav",
  "audio/flac": "flac",
};

function urlPath(url) {
  try {
    return new URL(url).pathname;
  } catch (e) {
    return "";
  }
}

function kindOf(url, mime) {
  const path = urlPath(url).toLowerCase();
  if (path.endsWith(".m3u8") || /mpegurl/i.test(mime || "")) return "hls";
  if (path.endsWith(".mpd") || /dash\+xml/i.test(mime || "")) return "dash";
  return "file";
}

function fileExt(entry) {
  const m = urlPath(entry.url).match(/\.([a-z0-9]{2,4})$/i);
  if (m) return m[1].toLowerCase();
  return EXT_BY_MIME[entry.mime] || (entry.audioOnly ? "mp3" : "mp4");
}

function formatSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function formatDuration(sec) {
  if (!sec) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function displayName(entry) {
  let name = "";
  try {
    name = decodeURIComponent(urlPath(entry.url).split("/").pop() || "");
  } catch (e) {
    name = "";
  }
  return name || new URL(entry.url).hostname;
}

// Without extension - HLS jobs append it once the container format is known.
function videoBaseName(index) {
  const title = (currentTitle || "").trim() || "video";
  return downloadPath(settings, currentHost, currentTitle, `${title.slice(0, 80)}_${index + 1}`);
}

function loadPlaylist(url) {
  if (!playlists.has(url)) {
    playlists.set(
      url,
      fetch(url, { credentials: "include", signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((text) => parseM3U8(text, url))
        .catch(() => null)
    );
  }
  return playlists.get(url);
}

async function buildVideoEntries() {
  const key = "media:" + currentTabId;
  const sniffed = (await chrome.storage.session.get(key))[key] || [];

  const merged = new Map();
  for (const item of sniffed) merged.set(item.url, { ...item });
  for (const item of domVideos) {
    const existing = merged.get(item.url);
    merged.set(item.url, { kind: kindOf(item.url, ""), mime: "", size: 0, ...existing, ...item });
  }

  const entries = Array.from(merged.values());
  await Promise.all(
    entries.filter((e) => e.kind === "hls").map(async (e) => (e.playlist = await loadPlaylist(e.url)))
  );

  // Variant/audio playlists referenced by a master playlist are offered as qualities of that master.
  const children = new Set();
  for (const e of entries) {
    if (e.playlist && e.playlist.type === "master") {
      e.playlist.variants.forEach((v) => children.add(v.url));
      e.playlist.audio.forEach((a) => children.add(a.url));
    }
  }

  const rank = (e) => {
    if (e.kind === "hls") return e.playlist && e.playlist.type === "master" ? 0 : 1;
    return e.kind === "file" ? 2 : 3;
  };
  return entries
    .filter((e) => !children.has(e.url))
    .sort((a, b) => rank(a) - rank(b) || (b.size || 0) - (a.size || 0));
}

function startHlsDownload(entry, index) {
  const base = videoBaseName(index);
  const pl = entry.playlist;
  let url = entry.url;
  let audioTrack = null;
  if (pl && pl.type === "master" && pl.variants.length) {
    const variant = pl.variants[selectedVariant.get(entry.url) || 0];
    url = variant.url;
    if (variant.audioGroup) {
      const group = pl.audio.filter((a) => a.group === variant.audioGroup);
      audioTrack = group.find((a) => a.isDefault) || group[0] || null;
    }
  }
  const send = (jobId, jobUrl, filename) =>
    chrome.runtime.sendMessage({
      target: "background",
      type: "hls-start",
      jobId,
      entryUrl: entry.url,
      url: jobUrl,
      filename,
      saveAs: settings.saveAs,
    });
  send(entry.url, url, base);
  // Separate audio renditions can't be muxed without ffmpeg, so they're saved as a second file.
  if (audioTrack) send(entry.url + "#audio", audioTrack.url, base + "_audio");
}

function cancelHlsDownload(entry) {
  chrome.runtime.sendMessage({ target: "background", type: "hls-cancel", jobId: entry.url });
  chrome.runtime.sendMessage({ target: "background", type: "hls-cancel", jobId: entry.url + "#audio" });
}

function renderVideoRow(entry, index) {
  const row = document.createElement("div");
  row.className = "video";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  if (entry.poster) {
    const img = document.createElement("img");
    img.src = entry.poster;
    thumb.appendChild(img);
  } else {
    thumb.textContent = entry.audioOnly || (entry.mime || "").startsWith("audio/") ? "♪" : "▶";
  }
  row.appendChild(thumb);

  const body = document.createElement("div");
  body.className = "vbody";

  const name = document.createElement("div");
  name.className = "vname";
  name.textContent = displayName(entry);
  name.title = entry.url;
  body.appendChild(name);

  const pl = entry.playlist;
  const isMaster = pl && pl.type === "master";
  const details = [];
  if (entry.width && entry.height) details.push(`${entry.width}×${entry.height}`);
  details.push(formatSize(entry.size));
  details.push(formatDuration(entry.duration || (pl && pl.type === "media" ? pl.duration : 0)));
  if (pl && pl.type === "media" && pl.live) details.push("živě");
  if (isMaster) details.push(`${pl.variants.length} kvalit`);

  const meta = document.createElement("div");
  meta.className = "vmeta";
  const badge = document.createElement("span");
  badge.className = "badge badge-" + entry.kind;
  badge.textContent = entry.kind === "file" ? fileExt(entry).toUpperCase() : entry.kind.toUpperCase();
  meta.appendChild(badge);
  meta.appendChild(document.createTextNode(" " + details.filter(Boolean).join(" · ")));
  body.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "vactions";

  if (isMaster && pl.variants.length > 1) {
    const select = document.createElement("select");
    pl.variants.forEach((v, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      const kbps = v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kb/s` : "";
      opt.textContent = [v.resolution, kbps].filter(Boolean).join(" · ") || `Varianta ${i + 1}`;
      select.appendChild(opt);
    });
    select.value = selectedVariant.get(entry.url) || 0;
    select.addEventListener("change", () => selectedVariant.set(entry.url, parseInt(select.value, 10)));
    actions.appendChild(select);
  }

  const dlBtn = document.createElement("button");
  dlBtn.className = "primary";
  dlBtn.textContent = "Stáhnout";
  if (entry.kind === "dash") {
    dlBtn.disabled = true;
    dlBtn.title = "DASH zatím není podporován - zkopírujte URL (např. pro yt-dlp)";
  } else if (entry.kind === "hls" && !pl) {
    dlBtn.disabled = true;
    dlBtn.title = "Playlist se nepodařilo načíst";
  }
  actions.appendChild(dlBtn);

  const copyBtn = document.createElement("button");
  copyBtn.textContent = "⧉";
  copyBtn.title = "Kopírovat URL";
  copyBtn.addEventListener("click", () => navigator.clipboard.writeText(entry.url));
  actions.appendChild(copyBtn);

  const openBtn = document.createElement("button");
  openBtn.textContent = "↗";
  openBtn.title = "Otevřít v nové záložce";
  openBtn.addEventListener("click", () => chrome.tabs.create({ url: entry.url }));
  actions.appendChild(openBtn);

  body.appendChild(actions);

  const progress = document.createElement("div");
  progress.className = "progress";
  progress.hidden = true;
  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  bar.appendChild(fill);
  const progressText = document.createElement("span");
  progress.append(bar, progressText);
  body.appendChild(progress);

  row.appendChild(body);

  if (dlBtn.disabled) return row;

  if (entry.kind === "file") {
    dlBtn.addEventListener("click", () =>
      chrome.downloads.download({
        url: entry.url,
        filename: `${videoBaseName(index)}.${fileExt(entry)}`,
        conflictAction: "uniquify",
        saveAs: settings.saveAs,
      })
    );
    return row;
  }

  let running = false;
  dlBtn.addEventListener("click", () => (running ? cancelHlsDownload(entry) : startHlsDownload(entry, index)));

  const update = () => {
    const job = jobs[entry.url];
    running = !!job && job.state === "running";
    dlBtn.textContent = running ? "Zrušit" : "Stáhnout";
    progress.hidden = !job;
    if (!job) return;
    progress.classList.toggle("error", job.state === "error");
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    fill.style.width = (job.state === "done" ? 100 : pct) + "%";
    const audioNote = jobs[entry.url + "#audio"] ? " (+ zvuk zvlášť)" : "";
    if (job.state === "error") progressText.textContent = "Chyba: " + job.error;
    else if (job.state === "done") progressText.textContent = "Hotovo" + audioNote;
    else if (!job.total) progressText.textContent = "Připravuji…";
    else {
      const stats = [`${pct} %`, formatSize(job.bytes)];
      if (job.speed) stats.push(`${formatSize(job.speed)}/s`);
      if (job.eta && job.done > 2) stats.push(`zbývá ${formatDuration(job.eta)}`);
      progressText.textContent = stats.filter(Boolean).join(" · ") + audioNote;
    }
  };
  jobViews.set(entry.url, update);
  update();

  return row;
}

function isYouTube(host) {
  return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host);
}

function renderVideos() {
  vidListEl.innerHTML = "";
  jobViews.clear();
  vidCountEl.textContent = videoEntries.length ? `(${videoEntries.length})` : "";
  const youtube = isYouTube(currentHost);
  vidNoticeEl.hidden = !youtube;
  if (youtube) ytCmdEl.textContent = `yt-dlp "${currentUrl}"`;
  if (!videoEntries.length) {
    vidStatusEl.hidden = youtube;
    vidStatusEl.textContent = blobPlayers
      ? "Přehrávač načítá stream. Spusťte přehrávání videa - stream bude zachycen automaticky."
      : "Žádná videa zatím nenalezena. Pokud stránka obsahuje přehrávač, spusťte přehrávání.";
    return;
  }
  vidStatusEl.hidden = true;
  videoEntries.forEach((entry, index) => vidListEl.appendChild(renderVideoRow(entry, index)));
}

let refreshGeneration = 0;

async function refreshVideos() {
  const generation = ++refreshGeneration;
  const entries = await buildVideoEntries();
  if (generation !== refreshGeneration) return; // a newer refresh is in flight
  videoEntries = entries;
  renderVideos();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  if (changes.jobs) {
    jobs = changes.jobs.newValue || {};
    jobViews.forEach((update) => update());
  }
  if (currentTabId !== null && changes["media:" + currentTabId]) refreshVideos();
});

// ---- Settings ----

const settingsForm = document.getElementById("settingsForm");
const openSettingsBtn = document.getElementById("openSettings");
const pathPreviewEl = document.getElementById("pathPreview");
let panelBeforeSettings = "images";
let filtersChanged = false; // image filters changed -> rescan when leaving settings
let saveTimer = null;

function fillSettingsForm() {
  const f = settingsForm.elements;
  f.rootFolder.value = settings.rootFolder;
  f.subfolder.value = settings.subfolder;
  f.saveAs.checked = settings.saveAs;
  f.minImageSize.value = settings.minImageSize;
  f.skipNoise.checked = settings.skipNoise;
  f.videoBadge.checked = settings.videoBadge;
}

function readSettingsForm() {
  const f = settingsForm.elements;
  const minSize = parseInt(f.minImageSize.value, 10);
  return {
    rootFolder: f.rootFolder.value,
    subfolder: f.subfolder.value || DEFAULT_SETTINGS.subfolder,
    saveAs: f.saveAs.checked,
    minImageSize: Number.isFinite(minSize) ? Math.max(0, minSize) : DEFAULT_SETTINGS.minImageSize,
    skipNoise: f.skipNoise.checked,
    videoBadge: f.videoBadge.checked,
  };
}

function updatePathPreview() {
  pathPreviewEl.textContent = downloadPath(settings, currentHost, currentTitle, "01_obrazek.jpg");
}

function applySettings(next) {
  if (next.minImageSize !== settings.minImageSize || next.skipNoise !== settings.skipNoise) filtersChanged = true;
  settings = next;
  updatePathPreview();
  // Debounced: storage.sync limits write frequency and typing fires on every key.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSettings(settings);
  }, 300);
}

settingsForm.addEventListener("input", () => applySettings(readSettingsForm()));

// Popup can close before the debounced save fires.
window.addEventListener("pagehide", () => {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  saveSettings(settings);
});

document.getElementById("resetSettings").addEventListener("click", () => {
  applySettings({ ...DEFAULT_SETTINGS });
  fillSettingsForm();
});

openSettingsBtn.addEventListener("click", () => {
  if (activePanel === "settings") {
    showPanel(panelBeforeSettings);
    return;
  }
  panelBeforeSettings = activePanel;
  fillSettingsForm();
  updatePathPreview();
  showPanel("settings");
});

// ---- Tabs & scanning ----

let activePanel = "images";

function showPanel(name) {
  const leavingSettings = activePanel === "settings" && name !== "settings";
  activePanel = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.panel === name));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== name));
  openSettingsBtn.classList.toggle("active", name === "settings");
  if (leavingSettings && filtersChanged) {
    filtersChanged = false;
    scan();
  }
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showPanel(t.dataset.panel)));

const FRAME_TIMEOUT = 4000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// allFrames waits for every frame; one stuck frame (ads, embedded players) would block forever
// and one error page frame rejects the whole call - fall back to the main frame alone.
async function runInPage(tabId, func, args) {
  const opts = { func, args, injectImmediately: true };
  try {
    return await withTimeout(
      chrome.scripting.executeScript({ ...opts, target: { tabId, allFrames: true } }),
      FRAME_TIMEOUT
    );
  } catch (e) {
    return withTimeout(chrome.scripting.executeScript({ ...opts, target: { tabId } }), FRAME_TIMEOUT);
  }
}

async function scan() {
  statusEl.hidden = false;
  statusEl.textContent = "Skenuji stránku…";
  gridEl.innerHTML = "";
  toolbarEl.hidden = true;
  vidStatusEl.hidden = false;
  vidStatusEl.textContent = "Skenuji stránku…";
  vidListEl.innerHTML = "";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    statusEl.textContent = vidStatusEl.textContent = "Nelze najít záložku.";
    return;
  }
  currentTabId = tab.id;
  currentTitle = tab.title || "";
  currentUrl = tab.url || "";
  try {
    currentHost = new URL(tab.url).hostname || "page";
  } catch (e) {
    currentHost = "page";
  }

  jobs = (await chrome.storage.session.get("jobs")).jobs || {};
  const filterOpts = { minImageSize: settings.minImageSize, skipNoise: settings.skipNoise };

  let imageItems = [];
  domVideos = [];
  blobPlayers = 0;

  // Network-sniffed media doesn't depend on the page scan, so list it right away.
  const earlyVideos = refreshVideos();

  try {
    const [imageResults, videoResults] = await Promise.all([
      runInPage(tab.id, extractImages, [filterOpts]),
      runInPage(tab.id, extractVideos, []),
    ]);
    const merged = new Map();
    for (const frameResult of imageResults) {
      const items = frameResult.result || [];
      for (const item of items) {
        const existing = merged.get(item.url);
        if (!existing || item.area > existing.area) merged.set(item.url, item);
      }
    }
    imageItems = Array.from(merged.values()).sort((a, b) => b.area - a.area);
    render(imageItems);

    for (const frameResult of videoResults) {
      const r = frameResult.result;
      if (!r) continue;
      domVideos.push(...r.items);
      blobPlayers += r.blobPlayers;
    }
  } catch (e) {
    statusEl.textContent = "Na této stránce nelze skenovat.";
  }
  imgCountEl.textContent = imageItems.length ? `(${imageItems.length})` : "";

  await earlyVideos;
  await refreshVideos(); // merge in <video> elements found by the page scan
  if (!imageItems.length && videoEntries.length) showPanel("videos");
}

rescanBtn.addEventListener("click", scan);
downloadAllBtn.addEventListener("click", () => {
  currentItems.forEach((item, index) => {
    setTimeout(() => downloadItem(item, index), index * 150);
  });
});

loadSettings().then((s) => {
  settings = s;
  scan();
});
