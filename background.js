// Service worker: sniffs media requests per tab (like VideoDownloadHelper)
// and coordinates HLS downloads running in the offscreen document.

importScripts("settings.js");

const MEDIA_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv|flv|3gp|mp3|m4a|oga|ogg|opus|wav|flac)$/;
const SEGMENT_RE = /\.(ts|m4s|m4f|aac|cmfv|cmfa)$|[/_-](seg|segment|chunk|frag|fragment)[-_]?\d|init\.mp4$/;
const HLS_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);
const RANGE_PARAMS = ["range", "bytestart", "byteend", "rn", "rbuf"];
// Adaptive players (YouTube and similar) fetch separate video/audio chunks and assemble them via MSE.
// A single chunk isn't a playable file, so these hosts are never listed.
const ADAPTIVE_CHUNK_HOSTS = /(^|\.)(googlevideo\.com|youtube\.com)$/;
const MIN_FILE_SIZE = 100 * 1024; // smaller media files are usually UI sounds or fragments
const MAX_PER_TAB = 200;

function header(headers, name) {
  const h = headers && headers.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : "";
}

function classify(url, contentType) {
  let path;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch (e) {
    return null;
  }
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (HLS_TYPES.has(ct) || path.endsWith(".m3u8")) return "hls";
  if (ct === "application/dash+xml" || path.endsWith(".mpd")) return "dash";
  if (ct === "video/mp2t" || SEGMENT_RE.test(path)) return null;
  if (ct.startsWith("text/") || ct.includes("json") || ct.includes("html")) return null;
  if (ct.startsWith("video/") || ct.startsWith("audio/") || MEDIA_EXT.test(path)) return "file";
  return null;
}

// Chunk of a stream requested piece by piece (byte range in the query string) - not a complete file.
function isChunk(url) {
  try {
    const u = new URL(url);
    return ADAPTIVE_CHUNK_HOSTS.test(u.hostname) || RANGE_PARAMS.some((p) => u.searchParams.has(p));
  } catch (e) {
    return true;
  }
}

function totalSize(headers) {
  const range = header(headers, "content-range"); // "bytes 0-1023/123456"
  const m = range.match(/\/(\d+)$/);
  if (m) return parseInt(m[1], 10);
  return parseInt(header(headers, "content-length"), 10) || 0;
}

// ---- Per-tab storage (storage.session survives service worker restarts) ----

const cache = new Map();
let queue = Promise.resolve();

function updateTab(tabId, fn) {
  queue = queue
    .then(async () => {
      const key = "media:" + tabId;
      let list = cache.get(tabId);
      if (!list) list = (await chrome.storage.session.get(key))[key] || [];
      const next = fn(list);
      if (next === list) return;
      cache.set(tabId, next);
      if (next.length) await chrome.storage.session.set({ [key]: next });
      else await chrome.storage.session.remove(key);
      setBadge(tabId, next.length);
    })
    .catch(() => {});
  return queue;
}

let showBadge = DEFAULT_SETTINGS.videoBadge;
loadSettings().then((s) => (showBadge = s.videoBadge));

function setBadge(tabId, count) {
  const text = showBadge && count ? String(count) : "";
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  const s = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
  if (s.videoBadge === showBadge) return;
  showBadge = s.videoBadge;
  const all = await chrome.storage.session.get(null);
  for (const [key, list] of Object.entries(all)) {
    if (key.startsWith("media:")) setBadge(parseInt(key.slice(6), 10), list.length);
  }
});

function clearTab(tabId) {
  return updateTab(tabId, (list) => (list.length ? [] : list));
}

chrome.action.setBadgeBackgroundColor({ color: "#3a6df0" });

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId >= 0) clearTab(d.tabId);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const mime = header(d.responseHeaders, "content-type");
    const kind = classify(d.url, mime);
    if (!kind) return;
    if (kind === "file" && isChunk(d.url)) return;
    const size = kind === "file" ? totalSize(d.responseHeaders) : 0;
    if (kind === "file" && size && size < MIN_FILE_SIZE) return;
    const url = d.url;

    updateTab(d.tabId, (list) => {
      const existing = list.find((x) => x.url === url);
      if (existing) {
        if (size <= existing.size) return list;
        return list.map((x) => (x === existing ? { ...x, size } : x));
      }
      if (list.length >= MAX_PER_TAB) return list;
      return [...list, { url, kind, mime: mime.split(";")[0].trim(), size, ts: Date.now() }];
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  cache.delete(tabId);
  chrome.storage.session.remove("media:" + tabId);
});

// ---- HLS download jobs (run in offscreen document, which can create blob URLs) ----

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Spojení segmentů HLS streamu do jednoho souboru ke stažení.",
      })
      .finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

let jobQueue = Promise.resolve();

function setJob(jobId, patch) {
  jobQueue = jobQueue
    .then(async () => {
      const { jobs = {} } = await chrome.storage.session.get("jobs");
      if (patch === null) delete jobs[jobId];
      else if (!jobs[jobId] && !patch.entryUrl) return; // late message for a cancelled job
      else jobs[jobId] = { ...jobs[jobId], ...patch };
      await chrome.storage.session.set({ jobs });
    })
    .catch(() => {});
  return jobQueue;
}

const blobDownloads = new Map(); // downloadId -> blob URL to revoke

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || delta.state.current === "in_progress") return;
  const blobUrl = blobDownloads.get(delta.id);
  if (!blobUrl) return;
  blobDownloads.delete(delta.id);
  chrome.runtime.sendMessage({ target: "offscreen", type: "revoke", blobUrl }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "background") return;
  switch (msg.type) {
    case "hls-start":
      queue = queue
        .then(async () => {
          await setJob(msg.jobId, { entryUrl: msg.entryUrl, state: "running", done: 0, total: 0, error: null });
          await ensureOffscreen();
          await chrome.runtime.sendMessage({ ...msg, target: "offscreen" });
        })
        .catch((e) => setJob(msg.jobId, { state: "error", error: String(e.message || e) }));
      break;
    case "hls-cancel":
      chrome.runtime.sendMessage({ target: "offscreen", type: "cancel", jobId: msg.jobId }).catch(() => {});
      setJob(msg.jobId, null);
      break;
    case "job-progress":
      setJob(msg.jobId, { done: msg.done, total: msg.total, bytes: msg.bytes, speed: msg.speed, eta: msg.eta });
      break;
    case "job-error":
      setJob(msg.jobId, { state: "error", error: msg.error });
      break;
    case "job-done": {
      const download = { url: msg.blobUrl, filename: msg.filename, conflictAction: "uniquify", saveAs: !!msg.saveAs };
      chrome.downloads.download(download, (id) => {
        if (id !== undefined) blobDownloads.set(id, msg.blobUrl);
      });
      setJob(msg.jobId, { state: "done", done: msg.total, total: msg.total });
      break;
    }
  }
});
