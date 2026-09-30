// Offscreen document: downloads HLS segments, decrypts AES-128, joins them into one blob.

const CONCURRENCY = 6; // Chrome opens at most 6 HTTP/1.1 connections per host, more wouldn't help
const RETRIES = 3;
const jobs = new Map(); // jobId -> AbortController

function send(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: "background" }).catch(() => {});
}

async function fetchWithRetry(url, { byterange, signal, as = "arrayBuffer" } = {}) {
  const headers = byterange ? { Range: `bytes=${byterange.start}-${byterange.end}` } : undefined;
  let lastError;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers, signal, credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res[as]();
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastError = e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

function sequenceIV(sequence) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequence);
  return iv;
}

function hexIV(hex) {
  const clean = hex.replace(/^0x/i, "").padStart(32, "0");
  return new Uint8Array(clean.match(/../g).map((b) => parseInt(b, 16)));
}

async function runJob({ jobId, url, filename, saveAs }) {
  const controller = new AbortController();
  jobs.set(jobId, controller);
  const { signal } = controller;

  try {
    let playlist = parseM3U8(await fetchWithRetry(url, { signal, as: "text" }), url);
    let playlistUrl = url;
    if (playlist.type === "master") {
      if (!playlist.variants.length) throw new Error("Playlist neobsahuje žádné varianty");
      playlistUrl = playlist.variants[0].url;
      playlist = parseM3U8(await fetchWithRetry(playlistUrl, { signal, as: "text" }), playlistUrl);
    }
    const { segments, map, container } = playlist;
    if (!segments.length) throw new Error("Playlist neobsahuje žádné segmenty");
    if (segments.some((s) => s.key && s.key.method !== "AES-128")) {
      throw new Error("Stream je chráněn DRM (SAMPLE-AES) - nelze stáhnout");
    }

    const keys = new Map(); // key uri -> Promise<CryptoKey>
    const getKey = (uri) => {
      if (!keys.has(uri)) {
        keys.set(
          uri,
          fetchWithRetry(uri, { signal }).then((raw) =>
            crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"])
          )
        );
      }
      return keys.get(uri);
    };

    const parts = new Array(segments.length);
    const startedAt = Date.now();
    let done = 0;
    let bytes = 0;
    let lastReport = 0;
    const report = (force) => {
      const now = Date.now();
      if (!force && now - lastReport < 300) return;
      lastReport = now;
      const elapsed = (now - startedAt) / 1000;
      const speed = elapsed > 0 ? bytes / elapsed : 0;
      const eta = done ? (elapsed / done) * (segments.length - done) : 0;
      send({ type: "job-progress", jobId, done, total: segments.length, bytes, speed, eta });
    };
    report(true);

    let next = 0;
    const worker = async () => {
      while (next < segments.length) {
        const i = next++;
        const seg = segments[i];
        let data = await fetchWithRetry(seg.url, { byterange: seg.byterange, signal });
        if (seg.key) {
          const iv = seg.key.iv ? hexIV(seg.key.iv) : sequenceIV(seg.sequence);
          data = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, await getKey(seg.key.uri), data);
        }
        parts[i] = data;
        bytes += data.byteLength;
        done++;
        report(false);
      }
    };

    const init = map ? fetchWithRetry(map.url, { byterange: map.byterange, signal }) : null;
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (init) parts.unshift(await init);
    report(true);

    const blob = new Blob(parts, { type: container === "mp4" ? "video/mp4" : "video/mp2t" });
    const blobUrl = URL.createObjectURL(blob);
    send({ type: "job-done", jobId, blobUrl, filename: `${filename}.${container}`, saveAs, total: segments.length });
  } catch (e) {
    if (!signal.aborted) send({ type: "job-error", jobId, error: String(e.message || e) });
  } finally {
    jobs.delete(jobId);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "hls-start") runJob(msg);
  else if (msg.type === "cancel") jobs.get(msg.jobId)?.abort();
  else if (msg.type === "revoke") URL.revokeObjectURL(msg.blobUrl);
});
