<div align="center">

<img src="docs/logo.png" alt="OllamaStudio logo" width="128" height="128" />

# OllamaStudio

Desktop Windows app for managing a local **Ollama server**. OllamaStudio launches
`ollama serve` as its own child process, monitors metrics (GPU/CPU/RAM), manages models
and shows live logs.

</div>

![OllamaStudio dashboard](docs/screenshots/dashboard.png)

## Requirements

- **Node.js** 18+ and npm
- **Ollama CLI installed** ([ollama.com](https://ollama.com)) — the app does not bundle `ollama.exe`
- For GPU metrics: an NVIDIA GPU and `nvidia-smi` in PATH (per-process VRAM on Windows also uses performance counters)

## Important — port 11434

OllamaStudio **hosts** the server itself. The system Ollama tray app (autostart) must not hold port **11434**.

1. Click the Ollama icon in the system tray → **Quit**
2. Disable Ollama in **Startup apps** (Windows Settings → Apps → Startup)
3. Only then start OllamaStudio

On a port conflict the app shows a message and offers to terminate the conflicting processes.

## Screenshots

### Dashboard

Serve metrics, GPU/VRAM, active requests and history parsed from logs.

![Dashboard](docs/screenshots/dashboard.png)

### GPU & memory

Per-process VRAM (Windows counters / nvidia-smi), CPU, model CPU/GPU split and killing of Ollama processes.

![GPU & memory](docs/screenshots/gpu.png)

> Refresh the screenshots with: `npm run build` and then `node ./scripts/capture-screenshots.mjs`.
> The script starts the app in a maximized window and sends a chat request to `ollama serve`
> (picking the smallest installed model), so the shots show live activity, history and a
> loaded model. Requires at least one downloaded model.

## Running

### Development

```bash
npm install
npm run dev
```

### Build / installer

```bash
npm run build      # compiles main/preload/renderer
npm run pack       # unpacked app into release/win-unpacked/
npm run dist       # Windows installer (electron-builder, no code signing)
```

Output: the `release/` folder.

`npm run dist` produces an **unsigned** installer — `package.json` sets
`win.signAndEditExecutable: false` so the build does not require symlink permissions for winCodeSign.

After `pack`, run it directly:

```text
release\win-unpacked\OllamaStudio.exe
```

## App pages

| Page | Description |
|------|-------------|
| **Dashboard** | API status, GPU/VRAM, loaded models, activity + request history, live logs |
| **Models** | Pull / load / unload / delete / clone, Continue config (add / update / remove) |
| **GPU & memory** | Per-process VRAM, CPU, system RAM, kill Ollama/runner processes |
| **Server** | OLLAMA_* env + preset configuration (stored in the app config, not in Windows env) |
| **Logs** | Live stdout/stderr from `ollama serve` |

## System tray

- Closing the window hides it to the tray (the app keeps running)
- Menu: Show · Start/Stop serve · Restart · Quit (also stops serve)
- Single-instance — launching a second time opens the existing window

## Configuration

Stored in `%APPDATA%/ollamastudio/config.json` (Electron userData).

Load/serve presets: `%APPDATA%/ollamastudio/presets/`.

Serve logs: `%APPDATA%/ollamastudio/logs/ollama-serve.log`.

The Continue integration reads/writes `%USERPROFILE%\.continue\config.yaml`.

## Icon

The source is `build/icon-source.png` (a Ψ symbol merged with a llama silhouette). After
replacing it, regenerate the derived formats with `npm run icons` — this produces
`build/icon.ico` (16–256 px) for the window, tray and installer, plus `build/icon-256.png`.

The script never repaints the source, it only transforms it geometrically:

- `--fit` (default 96 %) scales the artwork up so it fills the icon area
- `--transparent` removes the dark plate around the artwork, giving the icon a transparent background

So `icon-source.png` may keep artwork with a large margin and a background plate.

Check small-size legibility with
`node ./scripts/make-icons.mjs build/icon-source.png --fit --transparent --preview`,
which writes zoomed 16/32/48 px previews into TEMP.

## Changelog & versions

Version changes live in [CHANGELOG.md](CHANGELOG.md). For every release always bump `version`
in `package.json` and add release notes (see the Cursor rule in `.cursor/rules/`).

The current version is shown in the window title (`OllamaStudio X.Y.Z`) and as a badge in the UI header.

## License

MIT
