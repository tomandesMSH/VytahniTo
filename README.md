# VytáhniTo

A Chrome extension that pulls every real image off the current page - including
ones protected against right-click saving.
allows copying, opening, or downloading.

![Preview](/preview.png)

## Features

- **Smart extraction** - scans `<img>` elements (including lazy-loaded and
  `srcset` variants) as well as CSS `background-image`.
- **Filter** - skips tiny images, and anything that looks like a logo.
- **Best quality pick** - when the same image appears multiple times, keeps the largest variant.
- **Download all** - grabs every found image at once and organizes it into a folder.
- **Settings** (⚙ in the popup) - main folder, split downloads by site (`VytahniTo/YouTube/…`),
  by page (`VytahniTo/iDNES/<page title>/…`) or not at all, ask where to save, minimum image size,
  logo/icon filter and the video count on the icon. Settings sync across your Chrome profiles.
- **Videos** (inspired by VideoDownloadHelper) - watches the page's network traffic
  and lists video/audio streams; the number of found media is shown on the icon.
  - direct files (MP4, WebM, MOV, MP3, ...) are downloaded as-is,
  - **HLS** (`.m3u8`) streams let you pick a quality; segments are downloaded,
    AES-128 decrypted if needed, and joined into a single `.ts` / `.mp4` file,
  - **DASH** (`.mpd`) and DRM-protected streams can't be downloaded - the URL can be copied (e.g. for yt-dlp).
  - **YouTube** isn't supported (same as VideoDownloadHelper in Chrome) - it streams video and audio
    as small token-protected chunks. The popup offers a ready-to-copy `yt-dlp` command instead.

  Tip: if a video isn't listed, start playing it - the stream is captured once the player requests it.

## Usage

1. Clone or download this repository.
2. Open `chrome://extensions` in any Chromium-based browser.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder.

## Permissions

- `activeTab` / `scripting` - to inject the scanning script into the page you're viewing.
- `downloads` - to save images and videos to disk.
- `clipboardWrite` - to copy image/video URLs.
- `webRequest` + host access to all sites - to detect video streams the page loads.
- `storage` - to remember detected videos per tab until it navigates away, and to keep your settings.
- `offscreen` - to join HLS segments into one file in the background.

## Věnování

Tento projekt je věnován mému učiteli, kterému byl zablokován pokus 
o kliknutí pravým tlačítkem myši, aby zvětšil obrázek.