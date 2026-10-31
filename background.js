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
  igAssets.delete(tabId);
  purgeIgThumbTried(tabId);
  return updateTab(tabId, (list) => (list.length ? [] : list));
}

// Instagram/Facebook CDN now rejects media requests (403) that arrive without a matching Referer/Origin,
// which breaks both chrome.downloads.download() and the offscreen fetch() calls (neither is page-initiated).
// Rewriting those headers for the CDN hosts makes such requests look like they came from instagram.com.
const IG_CDN_REFERER_RULE_ID = 9001;

function syncInstagramCdnRule() {
  chrome.declarativeNetRequest
    .updateDynamicRules({
      removeRuleIds: [IG_CDN_REFERER_RULE_ID],
      addRules: [
        {
          id: IG_CDN_REFERER_RULE_ID,
          priority: 1,
          condition: {
            requestDomains: ["cdninstagram.com", "fbcdn.net"],
            resourceTypes: ["media", "xmlhttprequest", "image", "other"],
          },
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.instagram.com/" },
              { header: "Origin", operation: "set", value: "https://www.instagram.com" },
            ],
          },
        },
      ],
    })
    .catch(() => {});
}
syncInstagramCdnRule();

chrome.action.setBadgeBackgroundColor({ color: "#3a6df0" });

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId >= 0) clearTab(d.tabId);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

// Instagram/Facebook CDN serves story/highlight video progressively: the player fetches it in
// pieces via ?bytestart=&byteend= query params (not a real HTTP Range header, so no Content-Range
// in the response - each piece just looks like its own small 200 file). A single piece isn't
// downloadable, but the same endpoint happily serves the WHOLE file in one response when asked for
// bytestart=0 and a byteend far past the end - the server clamps it to the real file size.
const IG_CDN_HOST_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/;
const IG_FULL_BYTEEND = "999999999999";

function igRangedUrl(url) {
  try {
    const u = new URL(url);
    if (!IG_CDN_HOST_RE.test(u.hostname)) return null;
    if (!u.searchParams.has("bytestart") || !u.searchParams.has("byteend")) return null;
    return url;
  } catch (e) {
    return null;
  }
}

function igFullFileUrl(url) {
  return url.replace(/bytestart=\d+/, "bytestart=0").replace(/byteend=\d+/, `byteend=${IG_FULL_BYTEEND}`);
}

// Instagram preloads aggressively - not just the next/previous story, but apparently unrelated Reels
// clips too - so chunk requests for content the user isn't even watching show up right alongside the
// real one, and network-only signals (recency, size, even the audio/video role) aren't enough to tell
// them apart: a "video" and "audio" pair picked by those signals can end up belonging to two different
// clips entirely. The clip's URL carries a base64 "efg" param with its own metadata (encode tag,
// duration) - duration in particular can be cross-checked against the real <video> element's
// `duration` in the page (read by extractVideos() in popup.js, even though its `src` is an opaque
// blob: URL under MSE) to confirm a candidate is actually the one on screen. So: don't pick a winner
// here at all - surface every recently-touched clip with its decoded role/duration, and let popup.js
// filter by duration match against what's actually playing.
function igMeta(url) {
  try {
    const efg = new URL(url).searchParams.get("efg");
    if (!efg) return {};
    let b64 = efg.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const data = JSON.parse(atob(b64));
    const tag = (data.vencode_tag || "").toLowerCase();
    return {
      role: tag ? (tag.includes("audio") ? "audio" : "video") : null,
      duration: typeof data.duration_s === "number" ? data.duration_s : null,
      // The stable identity of the underlying clip - Instagram re-signs the same clip's URL (fresh
      // oh/oe tokens) on every request, so keying anything by the raw URL creates duplicate entries
      // for content already seen.
      assetId: data.xpv_asset_id != null ? String(data.xpv_asset_id) : null,
    };
  } catch (e) {
    return {};
  }
}

const IG_EVICT_MS = 30000; // a clip not touched for this long is assumed no longer relevant
const igPending = new Set(); // tabId + assetKey pairs with a size probe in flight
const igThumbTried = new Set(); // tabId + assetKey pairs a thumbnail job has already been sent for
const igAssets = new Map(); // tabId -> Map(assetKey -> { url, size, mime, role, duration, poster, firstSeen, lastSeen })

function syncIgEntries(tabId) {
  const assets = igAssets.get(tabId);
  if (!assets) return;
  const now = Date.now();
  for (const [key, a] of assets) if (now - a.lastSeen > IG_EVICT_MS) assets.delete(key);

  updateTab(tabId, (list) => {
    const kept = list.filter((x) => !x.ig);
    const fresh = [];
    for (const [key, a] of assets) {
      if (a.size == null) continue; // size/role probe still in flight
      fresh.push({
        url: a.url,
        kind: "file",
        mime: a.mime,
        size: a.size,
        ts: a.lastSeen, // when this clip was last (re-)touched, under any of its signed URLs
        firstSeen: a.firstSeen,
        poster: a.poster || "",
        ig: true,
        igRole: a.role,
        igDuration: a.duration,
      });
      // Runs independently of whatever the popup is doing, so a thumbnail still lands even if the
      // popup gets closed (opening it again just shows whatever's already in storage by then).
      if (!a.poster && a.role !== "audio") requestIgThumbnail(tabId, key, a.url);
    }
    const prevIg = list.filter((x) => x.ig);
    if (prevIg.length === fresh.length) {
      const prevByUrl = new Map(prevIg.map((x) => [x.url, x.ts]));
      if (fresh.every((f) => prevByUrl.get(f.url) === f.ts)) return list; // nothing actually changed
    }
    return [...kept, ...fresh];
  });
}

function purgeIgThumbTried(tabId) {
  const prefix = tabId + ":";
  for (const key of igThumbTried) if (key.startsWith(prefix)) igThumbTried.delete(key);
}

function requestIgThumbnail(tabId, assetKey, url) {
  const pendingKey = tabId + ":" + assetKey;
  if (igThumbTried.has(pendingKey)) return;
  igThumbTried.add(pendingKey);
  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ target: "offscreen", type: "ig-thumb", tabId, assetKey, url }))
    .catch(() => igThumbTried.delete(pendingKey)); // let a later sync retry
}

function touchInstagramVideo(tabId, mime, originalUrl) {
  const fullUrl = igFullFileUrl(originalUrl);
  const meta = igMeta(originalUrl);
  // xpv_asset_id is shared between a clip's video and audio renditions, not just re-signed copies
  // of the same rendition - so the role has to be part of the identity, or one track's URL silently
  // overwrites the other's.
  const assetKey = meta.assetId ? `${meta.assetId}:${meta.role || "?"}` : fullUrl;
  if (!igAssets.has(tabId)) igAssets.set(tabId, new Map());
  const assets = igAssets.get(tabId);
  const pendingKey = tabId + ":" + assetKey;
  const now = Date.now();

  const existing = assets.get(assetKey);
  if (existing) {
    existing.url = fullUrl; // keep the freshest signed URL - earlier ones can expire
    existing.lastSeen = now;
    syncIgEntries(tabId);
    return;
  }

  assets.set(assetKey, {
    url: fullUrl,
    size: null,
    mime: null,
    role: meta.role,
    duration: meta.duration,
    firstSeen: now,
    lastSeen: now,
  });

  if (igPending.has(pendingKey)) return;
  igPending.add(pendingKey);
  fetch(fullUrl, { credentials: "include" })
    .then((res) => {
      igPending.delete(pendingKey);
      const asset = assets.get(assetKey);
      if (!asset) return; // evicted while the probe was in flight
      if (!res.ok) {
        assets.delete(assetKey);
        return;
      }
      res.body && res.body.cancel && res.body.cancel();
      const size = parseInt(res.headers.get("content-length"), 10) || 0;
      // MIN_FILE_SIZE (100 KB) exists to filter generic page noise (UI sounds, tiny fragments) where
      // there's no other signal to go on. A short clip's audio track can legitimately be well under
      // that - a 9s AAC track can be 30-80 KB - so here, where the efg tag already confirms this is a
      // real content track, just reject truly empty/broken responses instead.
      if (size && size < 2048) {
        assets.delete(assetKey);
        return;
      }
      // The CDN reports "video/mp4" for every track regardless of content, so trust the efg tag.
      asset.size = size;
      asset.mime = meta.role === "audio" ? "audio/mp4" : (res.headers.get("content-type") || mime).split(";")[0].trim();
      syncIgEntries(tabId);
    })
    .catch(() => {
      igPending.delete(pendingKey);
      assets.delete(assetKey);
    });
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    const mime = header(d.responseHeaders, "content-type");
    const kind = classify(d.url, mime);
    if (!kind) return;
    if (kind === "file" && isChunk(d.url)) {
      const igUrl = igRangedUrl(d.url);
      if (igUrl) touchInstagramVideo(d.tabId, mime, igUrl);
      return;
    }
    const size = kind === "file" ? totalSize(d.responseHeaders) : 0;
    if (kind === "file" && size && size < MIN_FILE_SIZE) return;
    const url = d.url;

    updateTab(d.tabId, (list) => {
      const existing = list.find((x) => x.url === url);
      if (existing) {
        if (size <= existing.size) return list;
        return list.map((x) => (x === existing ? { ...x, size, ts: Date.now() } : x));
      }
      if (list.length >= MAX_PER_TAB) return list;
      const now = Date.now();
      return [...list, { url, kind, mime: mime.split(";")[0].trim(), size, ts: now, firstSeen: now }];
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  cache.delete(tabId);
  igAssets.delete(tabId);
  purgeIgThumbTried(tabId);
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
        justification: "Spojení segmentů HLS streamu nebo zvuku a videa (ffmpeg.wasm) do jednoho souboru ke stažení.",
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

// Debug-only back door: lets a page on instagram.com (via the page console, or an automation tool
// driving the browser) ask the extension for its current state directly, instead of a human having
// to open the service worker / offscreen DevTools and paste console output by hand. Scoped to
// instagram.com via manifest's externally_connectable, plus a throwaway shared token as a second
// layer - this is a development aid, not meant to protect anything sensitive.
const DEBUG_TOKEN = "vytahnito-debug-9f3";

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.token !== DEBUG_TOKEN) return;
  if (msg.type === "debug-dump") {
    chrome.storage.session.get(null).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "background") return;
  switch (msg.type) {
    case "clear-all":
      clearTab(msg.tabId);
      break;
    case "hls-start":
      queue = queue
        .then(async () => {
          await setJob(msg.jobId, { entryUrl: msg.entryUrl, state: "running", done: 0, total: 0, error: null });
          await ensureOffscreen();
          await chrome.runtime.sendMessage({ ...msg, target: "offscreen" });
        })
        .catch((e) => setJob(msg.jobId, { state: "error", error: String(e.message || e) }));
      break;
    case "hls-retry":
    case "hls-save-partial": {
      if (msg.type === "hls-retry") setJob(msg.jobId, { state: "running" });
      const type = msg.type === "hls-retry" ? "retry" : "save-partial";
      // After a browser restart the offscreen document is gone; recreating it lets it report the job as lost.
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ target: "offscreen", type, jobId: msg.jobId }))
        .catch((e) => setJob(msg.jobId, { state: "error", error: String(e.message || e) }));
      break;
    }
    case "hls-cancel":
      chrome.runtime.sendMessage({ target: "offscreen", type: "cancel", jobId: msg.jobId }).catch(() => {});
      setJob(msg.jobId, null);
      break;
    case "ig-merge-start":
      queue = queue
        .then(async () => {
          await setJob(msg.jobId, { entryUrl: msg.entryUrl, state: "running", done: 0, total: 100, error: null });
          await ensureOffscreen();
          await chrome.runtime.sendMessage({ ...msg, target: "offscreen", type: "ig-merge" });
        })
        .catch((e) => setJob(msg.jobId, { state: "error", error: String(e.message || e) }));
      break;
    case "ig-merge-cancel":
      chrome.runtime.sendMessage({ target: "offscreen", type: "ig-merge-cancel", jobId: msg.jobId }).catch(() => {});
      setJob(msg.jobId, null);
      break;
    case "ig-thumb-done": {
      const assets = igAssets.get(msg.tabId);
      const asset = assets && assets.get(msg.assetKey);
      if (asset) {
        asset.poster = msg.poster;
        syncIgEntries(msg.tabId);
      }
      break;
    }
    case "job-progress":
      setJob(msg.jobId, {
        done: msg.done,
        total: msg.total,
        bytes: msg.bytes,
        speed: msg.speed,
        eta: msg.eta,
        failed: msg.failed,
      });
      break;
    case "job-partial":
      setJob(msg.jobId, { state: "partial", done: msg.done, total: msg.total, failed: msg.failed, speed: 0, eta: 0 });
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
