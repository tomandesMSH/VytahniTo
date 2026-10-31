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

// ---- Instagram-style audio+video merge (separate CDN tracks -> one playable mp4, via ffmpeg.wasm) ----

const mergeJobs = new Map(); // jobId -> AbortController
let ffmpegInstance = null;
let ffmpegLoading = null;

function getFFmpeg() {
  if (ffmpegInstance) return Promise.resolve(ffmpegInstance);
  if (!ffmpegLoading) {
    ffmpegLoading = (async () => {
      const ff = new FFmpegWASM.FFmpeg();
      await ff.load({
        coreURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.js"),
        wasmURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.wasm"),
      });
      ffmpegInstance = ff;
      return ff;
    })();
  }
  return ffmpegLoading;
}

async function runMergeJob({ jobId, videoUrl, audioUrl, filename, saveAs }) {
  const controller = new AbortController();
  const signal = controller.signal;
  mergeJobs.set(jobId, controller);
  const tag = jobId.replace(/[^a-z0-9]/gi, "").slice(-24);
  const videoName = `v_${tag}.mp4`;
  const audioName = `a_${tag}.m4a`;
  const outName = `o_${tag}.mp4`;
  let ff;
  let step = "start";
  try {
    send({ type: "job-progress", jobId, done: 5, total: 100, bytes: 0, speed: 0, eta: 0, failed: 0 });
    step = "fetch";
    const [videoData, audioData] = await Promise.all([
      fetchWithRetry(videoUrl, { as: "arrayBuffer", signal }),
      fetchWithRetry(audioUrl, { as: "arrayBuffer", signal }),
    ]);
    if (signal.aborted) return;
    send({
      type: "job-progress",
      jobId,
      done: 25,
      total: 100,
      bytes: videoData.byteLength + audioData.byteLength,
      speed: 0,
      eta: 0,
      failed: 0,
    });

    step = "ffmpeg-load";
    ff = await getFFmpeg();
    if (signal.aborted) return;

    step = "write-files";
    await ff.writeFile(videoName, new Uint8Array(videoData));
    await ff.writeFile(audioName, new Uint8Array(audioData));

    step = "exec-on";
    const onProgress = ({ progress }) => {
      if (signal.aborted) return;
      const done = 25 + Math.max(0, Math.min(70, Math.round((progress || 0) * 70)));
      send({ type: "job-progress", jobId, done, total: 100, bytes: 0, speed: 0, eta: 0, failed: 0 });
    };
    ff.on("progress", onProgress);
    try {
      step = "exec-run";
      // Streams are already h264/aac inside an mp4 container - just remux them together, no re-encode.
      await ff.exec([
        "-i", videoName,
        "-i", audioName,
        "-c", "copy",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-movflags", "+faststart",
        outName,
      ]);
    } finally {
      ff.off("progress", onProgress);
    }
    if (signal.aborted) return;

    step = "read-output";
    const data = await ff.readFile(outName);
    const blob = new Blob([data.buffer], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);
    send({ type: "job-done", jobId, blobUrl, filename: `${filename}.mp4`, saveAs, total: 100 });
  } catch (e) {
    console.error("[VytahniTo] ig-merge failed at step:", step, e);
    send({
      type: "job-error",
      jobId,
      error: `[${step}] ` + String((e && e.stack) || (e && e.message) || e),
    });
  } finally {
    mergeJobs.delete(jobId);
    if (ff) {
      for (const name of [videoName, audioName, outName]) {
        try {
          await ff.deleteFile(name);
        } catch (e) {
          // not written, or already cleaned up - fine either way
        }
      }
    }
  }
}

// ---- Instagram thumbnail generation (runs here, not in the popup, so it survives the popup closing) ----
//
// Most sniffed clips were never actually played, so there's no live <video> element to snapshot.
// Instead: fetch just the first chunk of the file (Instagram's bytestart/byteend scheme makes this
// cheap - the usual byteend sentinel trick isn't involved here, we WANT a small slice), hand it to a
// throwaway <video> element, and grab a frame from it.

const IG_THUMB_BYTES = "400000"; // ~400 KB - enough for the moov box plus a few frames of a short clip

function igThumbUrl(url) {
  return url.replace(/byteend=\d+/, `byteend=${IG_THUMB_BYTES}`);
}

function grabFrameFromBlob(blob) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 5000);

    video.addEventListener("error", () => finish(null));
    video.addEventListener(
      "loadeddata",
      () => {
        const grab = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth || 320;
            canvas.height = video.videoHeight || 320;
            canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
            finish(canvas.toDataURL("image/jpeg", 0.6));
          } catch (e) {
            finish(null); // partial/undecodable data - just skip this one
          }
        };
        // A touch into the clip, so the grabbed frame isn't a black/blank opening frame.
        const seekTo = isFinite(video.duration) ? Math.min(0.2, video.duration / 4) : 0;
        if (seekTo > 0) {
          video.addEventListener("seeked", grab, { once: true });
          video.currentTime = seekTo;
        } else {
          grab();
        }
      },
      { once: true }
    );

    video.src = objectUrl;
  });
}

async function runThumbJob({ tabId, assetKey, url }) {
  try {
    const res = await fetch(igThumbUrl(url), { credentials: "include", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const blob = await res.blob();
    const poster = await grabFrameFromBlob(blob);
    if (!poster) return;
    send({ type: "ig-thumb-done", tabId, assetKey, poster });
  } catch (e) {
    // no thumbnail this time - the entry just keeps its default icon
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
  } else if (msg.type === "ig-merge") {
    runMergeJob(msg);
  } else if (msg.type === "ig-merge-cancel") {
    const controller = mergeJobs.get(msg.jobId);
    if (controller) {
      controller.abort();
      mergeJobs.delete(msg.jobId);
    }
  } else if (msg.type === "ig-thumb") {
    runThumbJob(msg);
  } else if (msg.type === "revoke") URL.revokeObjectURL(msg.blobUrl);
});
