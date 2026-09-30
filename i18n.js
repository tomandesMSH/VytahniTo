// UI translations. Static HTML uses data-i18n / data-i18n-title / data-i18n-placeholder attributes,
// scripts call t(key, ...args); "{0}", "{1}" in a message are replaced by the args.

const MESSAGES = {
  cs: {
    rescan: "Znovu skenovat",
    settings: "Nastavení",
    tabImages: "Obrázky",
    tabVideos: "Videa",
    downloadAll: "Stáhnout vše",
    scanning: "Skenuji…",
    scanningPage: "Skenuji stránku…",
    noTab: "Nelze najít záložku.",
    cannotScan: "Na této stránce nelze skenovat.",
    noImages: "Na stránce nebyly nalezeny žádné vhodné obrázky.",
    found: "Nalezeno: {0}",
    openInTab: "Otevřít v nové záložce",
    download: "Stáhnout",
    copyUrl: "Kopírovat URL",
    copyCommand: "Kopírovat příkaz",
    ytNotice:
      "YouTube posílá video po malých kouscích (obraz a zvuk zvlášť) chráněných tokeny, takže ho rozšíření v prohlížeči stáhnout neumí. Použijte",
    drmNotice:
      "Přehrávač na této stránce používá ochranu DRM (Widevine / PlayReady). Takto chráněné video rozšíření stáhnout nemůže - data dostává zašifrovaná a klíč zná jen přehrávač.",
    blobPlayer: "Přehrávač načítá stream. Spusťte přehrávání videa - stream bude zachycen automaticky.",
    noVideos: "Žádná videa zatím nenalezena. Pokud stránka obsahuje přehrávač, spusťte přehrávání.",
    live: "živě",
    qualities: "{0} kvalit",
    variant: "Varianta {0}",
    drmDisabled: "Video je chráněné DRM - nelze stáhnout",
    dashDisabled: "DASH zatím není podporován - zkopírujte URL (např. pro yt-dlp)",
    playlistFailed: "Playlist se nepodařilo načíst",
    retry: "Zkusit znovu",
    retryTitle: "Znovu stáhnout jen chybějící segmenty",
    savePartial: "Uložit i tak",
    savePartialTitle: "Uložit bez chybějících segmentů (ve videu budou krátké výpadky)",
    cancel: "Zrušit",
    audioSeparate: " (+ zvuk zvlášť)",
    error: "Chyba: {0}",
    done: "Hotovo",
    partialVideo: "Nepodařilo se stáhnout {0} z {1} segmentů videa",
    partialAudio: "Nepodařilo se stáhnout {0} z {1} segmentů zvuku",
    preparing: "Připravuji…",
    remaining: "zbývá {0}",
    errors: "{0} chyb",
    // Settings panel
    sectionSaving: "Ukládání",
    rootFolder: "Hlavní složka",
    rootFolderPlaceholder: "(přímo do Stažených souborů)",
    splitFolders: "Rozdělit do složek",
    bySite: "Podle webu",
    bySiteHint: "YouTube, iDNES…",
    byPage: "Každou stránku zvlášť",
    byPageHint: "web / název stránky",
    noSplit: "Nerozdělovat",
    savedAs: "Uloží se jako:",
    askWhere: "Ptát se, kam uložit",
    askWhereHint: "(jen u jednotlivých souborů, ne u „Stáhnout vše“)",
    sectionImages: "Obrázky",
    minSize: "Minimální velikost",
    skipNoise: "Skrývat loga, ikony a obrázky z hlavičky a patičky",
    sectionVideos: "Videa",
    videoBadge: "Zobrazovat počet nalezených videí na ikoně",
    sectionLanguage: "Jazyk",
    resetSettings: "Obnovit výchozí",
    sampleImage: "01_obrazek.jpg",
    // Errors reported by the HLS downloader
    "err.drm": "Video je chráněné DRM - nelze stáhnout",
    "err.noVariants": "Playlist neobsahuje žádné varianty",
    "err.noSegments": "Playlist neobsahuje žádné segmenty",
    "err.jobLost": "Rozpracované stahování už není k dispozici, spusťte ho znovu",
    "err.invalidPlaylist": "Neplatný HLS playlist",
  },
  en: {
    rescan: "Scan again",
    settings: "Settings",
    tabImages: "Images",
    tabVideos: "Videos",
    downloadAll: "Download all",
    scanning: "Scanning…",
    scanningPage: "Scanning the page…",
    noTab: "Can't find the tab.",
    cannotScan: "This page can't be scanned.",
    noImages: "No suitable images were found on this page.",
    found: "Found: {0}",
    openInTab: "Open in a new tab",
    download: "Download",
    copyUrl: "Copy URL",
    copyCommand: "Copy command",
    ytNotice:
      "YouTube streams video in small token-protected chunks (picture and sound separately), so the extension can't download it in the browser. Use",
    drmNotice:
      "The player on this page uses DRM protection (Widevine / PlayReady). The extension can't download video protected this way - it only gets encrypted data and only the player knows the key.",
    blobPlayer: "The player is loading a stream. Start playing the video - the stream will be captured automatically.",
    noVideos: "No videos found yet. If the page has a player, start playback.",
    live: "live",
    qualities: "{0} qualities",
    variant: "Variant {0}",
    drmDisabled: "The video is DRM-protected - can't be downloaded",
    dashDisabled: "DASH isn't supported yet - copy the URL (e.g. for yt-dlp)",
    playlistFailed: "Failed to load the playlist",
    retry: "Retry",
    retryTitle: "Download only the missing segments again",
    savePartial: "Save anyway",
    savePartialTitle: "Save without the missing segments (the video will have short gaps)",
    cancel: "Cancel",
    audioSeparate: " (+ separate audio)",
    error: "Error: {0}",
    done: "Done",
    partialVideo: "Failed to download {0} of {1} video segments",
    partialAudio: "Failed to download {0} of {1} audio segments",
    preparing: "Preparing…",
    remaining: "{0} left",
    errors: "{0} errors",
    // Settings panel
    sectionSaving: "Saving",
    rootFolder: "Main folder",
    rootFolderPlaceholder: "(directly into Downloads)",
    splitFolders: "Split into folders",
    bySite: "By website",
    bySiteHint: "YouTube, iDNES…",
    byPage: "Each page separately",
    byPageHint: "website / page title",
    noSplit: "Don't split",
    savedAs: "Saved as:",
    askWhere: "Ask where to save",
    askWhereHint: "(single files only, not “Download all”)",
    sectionImages: "Images",
    minSize: "Minimum size",
    skipNoise: "Hide logos, icons and images from the header and footer",
    sectionVideos: "Videos",
    videoBadge: "Show the number of found videos on the icon",
    sectionLanguage: "Language",
    resetSettings: "Restore defaults",
    sampleImage: "01_image.jpg",
    // Errors reported by the HLS downloader
    "err.drm": "The video is DRM-protected - can't be downloaded",
    "err.noVariants": "The playlist contains no variants",
    "err.noSegments": "The playlist contains no segments",
    "err.jobLost": "The unfinished download is no longer available, start it again",
    "err.invalidPlaylist": "Invalid HLS playlist",
  },
};

let currentLanguage = "cs";

function setLanguage(lang) {
  currentLanguage = MESSAGES[lang] ? lang : "en";
  if (typeof document !== "undefined") document.documentElement.lang = currentLanguage;
}

function t(key, ...args) {
  const msg = MESSAGES[currentLanguage][key] ?? MESSAGES.cs[key] ?? key;
  return msg.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? "");
}

// Translates every element marked with data-i18n* attributes under root.
function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
}
