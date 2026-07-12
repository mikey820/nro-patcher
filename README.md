# NRO Studio

A private, browser-based editor for Nintendo Switch homebrew `.nro` files. Change an app's embedded icon, name, author, and display version, then download a rebuilt NRO without uploading it to a server.

**Live site:** https://mikey820.github.io/nro-patcher/

## What it patches

- The JPEG icon in the NRO `ASET` section
- Name and author in every populated NACP language entry
- NACP display version
- ASET's 64-bit icon size and shifted NACP/RomFS offsets

The executable portion of the NRO is copied byte-for-byte and its declared size is never changed.

## Local development

The site has no build step or runtime dependencies:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. Run the binary fixture tests on macOS with:

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/nro.test.mjs
```

## Deployment

Pushes to `main` deploy the repository through the GitHub Pages Actions workflow.

## License

MIT
