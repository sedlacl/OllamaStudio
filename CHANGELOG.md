# Changelog

Všechny podstatné změny projektu evidujeme zde.
Formát vychází z [Keep a Changelog](https://keepachangelog.com/cs/1.1.0/),
verze ze [Semantic Versioning](https://semver.org/lang/cs/).

## [Unreleased]

## [1.2.1] — 2026-08-18

### Added

- Zápis a aktualizace vybraného Ollama modelu do konfigurace OpenCode
- Indikátor stavu konfigurace Continue a OpenCode u každého modelu (přítomný a aktuální / neaktuální / chybí / nástroj nemá config)
- Historie požadavků na Přehledu eviduje načtení modelu (start, dokončení i chyba)

### Changed

- Akce u modelů: primární zůstaly Načíst a Uvolnit, ostatní (Continue, OpenCode, detail, klonování, smazání) jsou v menu dalších akcí
- Context, Details a export JSON rozlišují runtime, Modelfile a serverové defaulty; velikost v dialogu načtení je označená jako soubor na disku, ne VRAM
- Výchozí Context Length v dialogu načtení modelu teď odpovídá efektivnímu num_ctx (Modelfile PARAMETER, jinak OLLAMA_CONTEXT_LENGTH, omezeno architekturou)

### Fixed

- Výchozí výška logu na dashboardu odpovídá cca 12 řádkům; zbytečný scrollbar u krátkého obsahu zmizí
- Dialog načtení modelu už současně neukazuje TTL 30m i „ponechat v paměti“ — posílá se jen jedna hodnota keep_alive

## [1.2.0] — 2026-08-12

### Added

- Přepínač jazyka **CZ / EN** v hlavičce (čeština výchozí), lokalizace UI i tray menu; jazyk se ukládá do localStorage a AppConfig

## [1.1.0] — 2026-08-12

### Added

- Podpora **Linuxu / WSL** vedle Windows (detekce Ollama CLI, ukončení procesů, metrika paměti)
- Konfigurace **OLLAMA_MODELS** na stránce Server (adresář modelů pro `ollama serve`)
- Na Linuxu/WSL automatická detekce Windows modelů pod `/mnt/*/Users/*/.ollama/models`, pokud je pole prázdné

### Changed

- README popisuje Windows i Linux (WSL), cesty konfigurace a sdílení modelů přes `OLLAMA_MODELS`

### Fixed

- Prázdné hodnoty v konfiguraci už nepřebíjejí smysluplný `OLLAMA_MODELS` z prostředí / WSL fallbacku

## [1.0.2] — 2026-08-12

### Added

- Verze aplikace v záhlaví okna i v hlavičce UI (titulek okna `OllamaStudio X.Y.Z`)
- Nová ikona aplikace: symbol Ψ (psi) splývající se siluetou lamy (Ollama), s průhledným pozadím — okno, tray, instalátor
- Skript `npm run icons` pro přegenerování `build/icon.ico` (16–256 px) ze zdrojového PNG; `--fit` motiv přiblíží na plochu ikony, `--transparent` odstraní podklad, `--preview` uloží náhledy 16/32/48 px

### Changed

- README screenshoty se pořizují v maximalizovaném okně a s běžícím chat požadavkem — je na nich vidět aktivita, historie i načtený model
- README je nově v angličtině a obsahuje logo aplikace v hlavičce

### Fixed

- CPU zátěž na Windows se čte z výkonnostního čítače (`Win32_PerfFormattedData_PerfOS_Processor`) a odpovídá Správci úloh — dřívější výpočet z `os.cpus()` byl nepřesný

## [1.0.1] — 2026-08-12

### Added

- Stránka **GPU a paměť**: per-proces VRAM (Windows performance counters + nvidia-smi), CPU zátěž, rozložení načtených modelů CPU/GPU
- Ukončení Ollama / llama-server procesů přímo z GPU stránky (serve přes řízený stop)
- Integrace **Continue** na stránce Modely (stav v `config.yaml`, nahrát / aktualizovat / odebrat)
- Presety pro dialog Načíst model a stránku Server (save / load / copy / import JSON)
- Aktivita na Přehledu: rezervované místo pro aktivní request, historie s typem úlohy (chat/generate/embed)
- Dokončené requesty v historii ukazují progress **100 %**
- Skript `scripts/capture-screenshots.mjs` pro README screenshoty
- Wrapper `scripts/electron-vite.mjs` — filtruje `--use-system-ca` z `NODE_OPTIONS` (Cursor / Electron)

### Changed

- Sloupec modelu **RAM (CPU)** místo matoucího „V RAM (CPU)“
- Společná komponenta `ModelSplitTable` pro Přehled i GPU

### Fixed

- Split bar GPU/CPU při chybějícím `size` z `/api/ps` už nevypadá jako 100 % na CPU

## [1.0.0] — 2026-08-12

### Added

- První veřejný release: hostování `ollama serve`, Přehled, Modely, Server, Logy, system tray
