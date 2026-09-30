// Minimal HLS (m3u8) playlist parser shared by the popup and the offscreen downloader.

function parseM3U8Attrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

function parseByteRange(str, prevEnd) {
  // "length[@offset]" -> { start, end } (end inclusive)
  const [len, off] = str.split("@");
  const start = off !== undefined ? parseInt(off, 10) : prevEnd;
  return { start, end: start + parseInt(len, 10) - 1 };
}

function parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("Neplatný HLS playlist");
  const abs = (u) => new URL(u, baseUrl).href;

  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF:"))) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
      const a = parseM3U8Attrs(lines[i].slice(18));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith("#")) j++;
      if (j >= lines.length) break;
      variants.push({
        url: abs(lines[j]),
        bandwidth: parseInt(a.BANDWIDTH, 10) || 0,
        resolution: a.RESOLUTION || "",
        audioGroup: a.AUDIO || null,
      });
    }
    const audio = lines
      .filter((l) => l.startsWith("#EXT-X-MEDIA:"))
      .map((l) => parseM3U8Attrs(l.slice(13)))
      .filter((a) => a.TYPE === "AUDIO" && a.URI)
      .map((a) => ({
        group: a["GROUP-ID"],
        url: abs(a.URI),
        name: a.NAME || a.LANGUAGE || "audio",
        isDefault: a.DEFAULT === "YES",
      }));
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { type: "master", variants, audio };
  }

  const segments = [];
  let mediaSequence = 0;
  let key = null;
  let map = null;
  let duration = 0;
  let pendingDuration = 0;
  let pendingRange = null;
  let lastRangeEnd = 0;
  let endList = false;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.slice(22), 10) || 0;
    } else if (line.startsWith("#EXTINF:")) {
      pendingDuration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = parseByteRange(line.slice(17), lastRangeEnd);
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseM3U8Attrs(line.slice(11));
      if (a.METHOD === "NONE") key = null;
      else if (a.METHOD === "AES-128") key = { method: a.METHOD, uri: abs(a.URI), iv: a.IV || null };
      else key = { method: a.METHOD };
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseM3U8Attrs(line.slice(11));
      map = { url: abs(a.URI), byterange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (line === "#EXT-X-ENDLIST") {
      endList = true;
    } else if (!line.startsWith("#")) {
      segments.push({
        url: abs(line),
        duration: pendingDuration,
        byterange: pendingRange,
        key,
        sequence: mediaSequence + segments.length,
      });
      duration += pendingDuration;
      if (pendingRange) lastRangeEnd = pendingRange.end + 1;
      pendingDuration = 0;
      pendingRange = null;
    }
  }

  const fmp4 = !!map || segments.some((s) => /\.(m4s|mp4|m4v|cmfv)(?:$|\?)/i.test(s.url));
  return { type: "media", segments, map, duration, live: !endList, container: fmp4 ? "mp4" : "ts" };
}
