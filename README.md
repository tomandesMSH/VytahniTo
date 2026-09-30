# VytáhniTo

A Chrome extension that pulls every real image off the current page - including
ones protected against right-click saving.
allows copying, opening, or downloading.

## Features

- **Smart extraction** - scans `<img>` elements (including lazy-loaded and
  `srcset` variants) as well as CSS `background-image`.
- **Filter** - skips tiny images, and anything that looks like a logo.
- **Best quality pick** - when the same image appears multiple times, keeps the largest variant.
- **Download all** - grabs every found image at once and organizes it into a folder.

## Usage

1. Clone or download this repository.
2. Open `chrome://extensions` in any Chromium-based browser.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder.

## Permissions

- `activeTab` / `scripting` - to inject the scanning script into the page you're viewing.
- `downloads` - to save images to disk.
- `clipboardWrite` - to copy image URLs.

## Věnování

Tento projekt je věnován mému učiteli, kterému byl zablokován pokus 
o kliknutí pravým tlačítkem myši, aby zvětšil obrázek.