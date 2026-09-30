// User settings and download path helpers, shared by the popup and the service worker.

const DEFAULT_SETTINGS = {
  rootFolder: "VytahniTo", // empty = save directly into Downloads
  subfolder: "site", // "site" | "page" | "none"
  saveAs: false, // ask where to save single downloads
  minImageSize: 100, // px, smaller images are skipped
  skipNoise: true, // skip logos, icons and images in header/footer/nav
  videoBadge: true, // show number of found videos on the extension icon
  language: /^cs/i.test(navigator.language) ? "cs" : "en", // "cs" | "en"
};

async function loadSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

function saveSettings(settings) {
  return chrome.storage.sync.set({ settings });
}

// Names that plain capitalization would get wrong.
const KNOWN_SITES = {
  youtube: "YouTube",
  youtu: "YouTube",
  fb: "Facebook",
  twitter: "X",
  x: "X",
  tiktok: "TikTok",
  redd: "Reddit",
  github: "GitHub",
  linkedin: "LinkedIn",
  imdb: "IMDb",
  deviantart: "DeviantArt",
  artstation: "ArtStation",
  soundcloud: "SoundCloud",
  aliexpress: "AliExpress",
  ebay: "eBay",
  bbc: "BBC",
  cnn: "CNN",
  idnes: "iDNES",
  irozhlas: "iRozhlas",
  ceskatelevize: "Česká televize",
  aktualne: "Aktuálně",
  denik: "Deník",
  bazos: "Bazoš",
  csfd: "ČSFD",
  ctk: "ČTK",
};

// Second-level labels used under country TLDs, e.g. "bbc.co.uk".
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

// "www.youtube.com" -> "YouTube", "shop.example.co.uk" -> "Example"
function siteName(host, language) {
  if (!host) return language === "en" ? "Other" : "Ostatní";
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host; // IP address
  const labels = host.toLowerCase().split(".");
  let i = labels.length - 2;
  if (i > 0 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[i])) i--;
  const name = labels[Math.max(i, 0)];
  return KNOWN_SITES[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 100);
}

// Chrome rejects path components with leading/trailing dots or spaces.
function sanitizePathPart(part) {
  return sanitizeFilename(part).trim().replace(/^\.+|\.+$/g, "").trim().slice(0, 80);
}

function downloadFolder(settings, host, pageTitle) {
  const parts = settings.rootFolder.split(/[/\\]/);
  if (settings.subfolder === "site" || settings.subfolder === "page") parts.push(siteName(host, settings.language));
  if (settings.subfolder === "page") parts.push(pageTitle || (settings.language === "en" ? "Untitled" : "Bez názvu"));
  return parts.map(sanitizePathPart).filter(Boolean).join("/");
}

function downloadPath(settings, host, pageTitle, filename) {
  const folder = downloadFolder(settings, host, pageTitle);
  const file = sanitizePathPart(filename) || "soubor";
  return folder ? `${folder}/${file}` : file;
}
