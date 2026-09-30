// Offscreen document: downloads HLS segments, decrypts AES-128, joins them into one blob.
// Errors are thrown as i18n keys ("err.*"), translated by the popup.

const CONCURRENCY = 6; // Chrome opens at most 6 HTTP/1.1 connections per host, more wouldn't help
const RETRIES = 4;
const ATTEMPT_TIMEOUT = 120 * 1000; // per request, so one stalled segment can't hang the whole job
const jobs = new Map(); // jobId -> job state, kept until saved or cancelled (also while partially failed)

function send(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: "background" }).catch(() => {});
}

async function fetchWithRetry(url, { byterange, signal, as = "arrayBuffer" } = {}) {
  const headers = byterange ? { Range: `bytes=${byterange.start}-${byterange.end}` } : undefined;
  let lastError;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT)]);
      const res = await fetch(url, { headers, signal: attemptSignal, credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res[as]();
    } catch (e) {
      if (signal.aborted) throw e;
      lastError = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
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

function getKey(job, uri) {
  if (!job.keys.has(uri)) {
    const key = fetchWithRetry(uri, { signal: job.signal }).then((raw) =>
      crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"])
    );
    key.catch(() => job.keys.delete(uri)); // let a retry fetch the key again
    job.keys.set(uri, key);
  }
  return job.keys.get(uri);
}

function report(job, force) {
  const now = Date.now();
  if (!force && now - job.lastReport < 300) return;
  job.lastReport = now;
  const elapsed = (now - job.startedAt) / 1000;
  const speed = elapsed > 0 ? job.sessionBytes / elapsed : 0;
  const eta = job.sessionDone ? (elapsed / job.sessionDone) * job.pending : 0;
  send({
    type: "job-progress",
    jobId: job.id,
    done: job.done,
    total: job.segments.length,
    bytes: job.bytes,
    speed,
    eta,
    failed: job.failed.size,
  });
}

async function downloadSegments(job, indices) {
  job.startedAt = Date.now();
  job.sessionBytes = 0;
  job.sessionDone = 0;
  job.pending = indices.length;
  report(job, true);

  let next = 0;
  const worker = async () => {
    while (next < indices.length) {
      const i = indices[next++];
      const seg = job.segments[i];
      try {
        let data = await fetchWithRetry(seg.url, { byterange: seg.byterange, signal: job.signal });
        if (seg.key) {
          const iv = seg.key.iv ? hexIV(seg.key.iv) : sequenceIV(seg.sequence);
          data = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, await getKey(job, seg.key.uri), data);
        }
        // Wrapping each segment in a Blob hands the bytes to Chrome's blob storage, which pages large
        // amounts to disk - so a long video doesn't have to fit in this document's memory.
        job.blobs[i] = new Blob([data]);
        job.failed.delete(i);
        job.bytes += data.byteLength;
        job.sessionBytes += data.byteLength;
        job.done++;
        job.sessionDone++;
      } catch (e) {
        if (job.signal.aborted) throw e;
        job.failed.add(i); // keep going; missing segments can be retried at the end
      }
      job.pending--;
      report(job, false);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  report(job, true);
}

function finish(job) {
  if (job.failed.size) {
    send({ type: "job-partial", jobId: job.id, done: job.done, total: job.segments.length, failed: job.failed.size });
  } else {
    save(job);
  }
}

function save(job) {
  const parts = job.blobs.filter(Boolean);
  if (job.init) parts.unshift(job.init);
  const blob = new Blob(parts, { type: job.container === "mp4" ? "video/mp4" : "video/mp2t" });
  const blobUrl = URL.createObjectURL(blob);
  jobs.delete(job.id);
  send({
    type: "job-done",
    jobId: job.id,
    blobUrl,
    filename: `${job.filename}.${job.container}`,
    saveAs: job.saveAs,
    total: job.segments.length,
  });
}

async function runJob({ jobId, url, filename, saveAs }) {
  const controller = new AbortController();
  const signal = controller.signal;
  const job = {
    id: jobId,
    controller,
    signal,
    filename,
    saveAs,
    segments: [],
    keys: new Map(),
    failed: new Set(),
    done: 0,
    bytes: 0,
    lastReport: 0,
  };
  jobs.set(jobId, job);

  try {
    let playlist = parseM3U8(await fetchWithRetry(url, { signal, as: "text" }), url);
    if (playlist.type === "master") {
      if (playlist.drm) throw new Error("err.drm");
      if (!playlist.variants.length) throw new Error("err.noVariants");
      const variantUrl = playlist.variants[0].url;
      playlist = parseM3U8(await fetchWithRetry(variantUrl, { signal, as: "text" }), variantUrl);
    }
    if (playlist.drm) throw new Error("err.drm");
    if (!playlist.segments.length) throw new Error("err.noSegments");

    job.segments = playlist.segments;
    job.container = playlist.container;
    job.blobs = new Array(playlist.segments.length);
    if (playlist.map) {
      job.init = new Blob([await fetchWithRetry(playlist.map.url, { byterange: playlist.map.byterange, signal })]);
    }

    await downloadSegments(job, job.segments.map((_, i) => i));
    finish(job);
  } catch (e) {
    jobs.delete(jobId);
    if (!signal.aborted) send({ type: "job-error", jobId, error: String(e.message || e) });
  }
}

function sendGone(jobId) {
  send({ type: "job-error", jobId, error: "err.jobLost" });
}

async function retryJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.failed.size) return sendGone(jobId);
  try {
    await downloadSegments(job, [...job.failed].sort((a, b) => a - b));
    finish(job);
  } catch (e) {
    jobs.delete(jobId);
    if (!job.signal.aborted) send({ type: "job-error", jobId, error: String(e.message || e) });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "hls-start") runJob(msg);
  else if (msg.type === "retry") retryJob(msg.jobId);
  else if (msg.type === "save-partial") {
    const job = jobs.get(msg.jobId);
    if (job && job.failed.size) save(job);
    else sendGone(msg.jobId);
  } else if (msg.type === "cancel") {
    const job = jobs.get(msg.jobId);
    if (job) {
      job.controller.abort();
      jobs.delete(msg.jobId);
    }
  } else if (msg.type === "revoke") URL.revokeObjectURL(msg.blobUrl);
});
