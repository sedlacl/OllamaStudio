# OllamaStudio

Desktopová Windows aplikace pro správu lokálního **Ollama serveru**. OllamaStudio spouští `ollama serve` jako vlastní child process, monitoruje metriky, spravuje modely a zobrazuje logy.

## Požadavky

- **Node.js** 18+ a npm
- **Nainstalované Ollama CLI** ([ollama.com](https://ollama.com)) — aplikace neobsahuje `ollama.exe`
- Pro GPU metriky: NVIDIA GPU a `nvidia-smi` v PATH

## Důležité — port 11434

OllamaStudio **hostuje** server sám. Systémová Ollama v tray (autostart) nesmí držet port **11434**.

1. Klikněte na ikonu Ollama v system tray → **Quit**
2. Vypněte Ollama v **Startup apps** (Nastavení Windows → Aplikace → Spuštění)
3. Teprve potom spusťte OllamaStudio

Při konfliktu portu aplikace zobrazí hlášku a nabídne ukončení konfliktních procesů.

## Spuštění vývojové verze

```bash
npm install
npm run dev
```

## Sestavení

```bash
npm run build      # zkompiluje main/preload/renderer
npm run dist       # Windows installer (electron-builder, bez kódu podepisování)
```

Výstup balíčku: složka `release/`.

`npm run dist` vytváří **nepodepsaný** instalátor — v `package.json` je `win.signAndEditExecutable: false`, aby build nevyžadoval symlink oprávnění pro winCodeSign na běžném Windows vývojářském prostředí.

## Stránky aplikace

| Stránka | Popis |
|---------|--------|
| **Přehled** | GPU/VRAM, načtené modely, paměť procesu, tok/s, uptime |
| **Modely** | Seznam, load/unload, pull, delete, klonování |
| **Server** | OLLAMA_* proměnné (ukládají se do configu app, ne do Windows env) |
| **Logy** | Live stdout/stderr z `ollama serve` |

## System tray

- Zavření okna = skrytí do tray (aplikace běží dál)
- Menu: Zobrazit · Start/Stop serve · Restart · Ukončit (zastaví i serve)
- Single-instance — druhé spuštění otevře existující okno

## Konfigurace

Ukládá se do `%APPDATA%/ollamastudio/config.json` (userData Electronu).

Logy serve: `%APPDATA%/ollamastudio/logs/ollama-serve.log`

## Licence

MIT
