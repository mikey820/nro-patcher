# 🎮 NRO Patcher

Browser-based tool to edit Nintendo Switch homebrew `.nro` files — change the app icon, name, author, and version. Everything runs locally; no file is ever uploaded anywhere.

**[Use it here →](https://mikey820.github.io/nro-patcher/)**

## Features

- **Drag & drop** an `.nro` file
- **Change the icon** — upload any image (PNG, JPEG, WebP), auto-converted to JPEG at 256×256
- **Edit metadata** — app name, author, display version
- **Instant download** — patched NRO rebuilt in the browser
- **Keyboard shortcut** — `Cmd+S` / `Ctrl+S` to download
- **Privacy-first** — all binary parsing/patching happens client-side

## Hosting on GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set **Source** to `main` branch, root folder
4. Save — your site is live at `https://<you>.github.io/nro-patcher/`

Or just open `index.html` locally — no server needed.

## How it works

NRO files embed an **ASET** section containing:
- A JPEG icon (typically 256×256)
- **NACP metadata** — the app title, author, and version string

The tool parses the binary structure, lets you edit these values, then rebuilds the file with corrected offsets and segment sizes.

## License

MIT — do whatever you want with it.
