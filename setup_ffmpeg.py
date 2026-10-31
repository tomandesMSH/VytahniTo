#!/usr/bin/env python3
"""Downloads the ffmpeg.wasm build VytahniTo's audio+video merge feature needs.

These files aren't committed to the repo (they're ~31 MB of binary), so this
script fetches them and places them under vendor/ffmpeg/ next to this file.

Usage:
    python setup_ffmpeg.py [cesta-k-VytahniTo]

Run it from inside the VytahniTo extension folder (where manifest.json lives),
or pass that folder as an argument. After it finishes, reload the extension in
chrome://extensions.
"""

import json
import sys
import urllib.request
from pathlib import Path

# ffmpeg.js and ffmpeg-core.js/.wasm must come from the SAME version pair - mixing
# them produces a TypeError at merge time (the JS glue calls wasm exports by a
# minified name that shifts between versions).
FFMPEG_VERSION = "0.12.10"
CORE_VERSION = "0.12.10"

FILES = [
    (f"https://unpkg.com/@ffmpeg/ffmpeg@{FFMPEG_VERSION}/dist/umd/ffmpeg.js", "vendor/ffmpeg/ffmpeg.js"),
    (f"https://unpkg.com/@ffmpeg/ffmpeg@{FFMPEG_VERSION}/dist/umd/814.ffmpeg.js", "vendor/ffmpeg/814.ffmpeg.js"),
    (f"https://unpkg.com/@ffmpeg/core@{CORE_VERSION}/dist/umd/ffmpeg-core.js", "vendor/ffmpeg/core/ffmpeg-core.js"),
    (f"https://unpkg.com/@ffmpeg/core@{CORE_VERSION}/dist/umd/ffmpeg-core.wasm", "vendor/ffmpeg/core/ffmpeg-core.wasm"),
]


def find_extension_root(start: Path) -> Path | None:
    for candidate in [start, *start.parents]:
        manifest = candidate / "manifest.json"
        if not manifest.exists():
            continue
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if "ytáhniTo" in data.get("name", "") or "ytahnito" in data.get("name", "").lower():
            return candidate
    return None


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  {url}\n  -> {dest}")
    urllib.request.urlretrieve(url, dest)


def main() -> None:
    start = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
    root = find_extension_root(start)
    if root is None:
        print(f"Nenasel jsem manifest.json rozsireni VytahniTo ve '{start}' ani jeho rodicovskych slozkach.")
        print("Spust tento skript ze slozky VytahniTo, nebo mu tu slozku predej jako argument:")
        print(f"  python {Path(__file__).name} cesta/k/VytahniTo")
        sys.exit(1)

    print(f"Instaluji ffmpeg.wasm (verze {FFMPEG_VERSION}) do {root / 'vendor' / 'ffmpeg'}\n")
    for url, rel_path in FILES:
        download(url, root / rel_path)

    print("\nHotovo. V chrome://extensions dej Reload na VytahniTo.")


if __name__ == "__main__":
    main()
