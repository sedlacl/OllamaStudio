# Changelog

Všechny podstatné změny projektu evidujeme zde.
Formát vychází z [Keep a Changelog](https://keepachangelog.com/cs/1.1.0/),
verze ze [Semantic Versioning](https://semver.org/lang/cs/).

## [Unreleased]

## [1.4.2] — 2026-08-28

### Security

- Redakce tajemství v logu: percent-encoded query parametry, YAML s jednoduchými uvozovkami u klíče i hodnoty, ANSI reset/timestamp za labelem Tabby klíče a řádky nad 64 KiB (fail-closed marker bez úniku payloadu, včetně více chunků)
- Hash-guarded runtime patch bundle (`common/auth.py`, `common/downloader.py`): reprodukovatelný LF manifest, legacy CRLF patched hash zůstává platný na disku, neznámý hash fail-close; ověření disk hash pro spawned/adopted/external proces
- Auth watcher: při změně `api_tokens.yml` okamžitá fail-closed redakce; staré klíče zůstávají registrované při transientně chybějícím/prázdném/neplatném souboru a uvolní se až po stabilním načtení nových hodnot (new-before-old)
- Centralizovaná Studio log persistence: jednorázový scrub historických logů až po registraci auth secretů, sdílený mutex pro writer/start/scrub/delete/clear, realpath guard před open/rename/delete
- Historické logy Studio lze bezpečně vyčistit tlačítkem Vymazat (včetně souboru na disku po potvrzení); textové logy Tabby runtime jdou scrubnout při zastaveném serveru (externí instance odmítnuta); ZIP archivy jen po explicitním potvrzení smazání
- Chybové stavy serve/model-load/download/HTTP/update/kill/scrub a cesty ve stavu/IPC se sanitizují před prvním uložením (včetně konfliktu HF downloadu a kill výsledků)

### Fixed

- Po přerušeném stažení z Hugging Face šlo znovu stáhnout jen ručním smazáním složky. Studio teď pozná existující složku, nabídne smazání, jiný název, nebo použití kompletního modelu — Tabby hlášku „path already exists“ už neukazuje jako syrové HTTP 400
- Selhání spojení s backendem už neukáže jen `fetch failed`. Banner na stránce Modely zůstane, dokud ho nezavřete (u stažení ho neumaže ani obnovení katalogu), řekne lidsky že server neběží / neposlouchá, a stejný záznam (včetně adresy) je v panelu logů
- Restart main procesu ve vývoji (electron-vite) už TabbyAPI nezabíjí přes Windows Job Object — probíhající stažení tím nespadne
- Průběh stažení z Hugging Face je v panelu logů (`[studio] tabby-download`) od startu po dokončení, přerušení i chybu — včetně obnovy nedokončené session po restartu. Token se do logu nezapisuje
- Stav stažení už není jen na stránce Modely: po přepnutí na jinou záložku a zpět panel pokračuje z aktuálního snapshotu v main procesu
- Když stažení neskončí úspěchem (chyba, přerušení, existující složka) nebo aplikace spadne uprostřed, Studio si pamatuje formulář i stav — po restartu nabídne smazání částečné složky nebo jiný název. TabbyAPI umí jen nové stažení, ne resume. Úspěšné stažení se po restartu neobnovuje jako aktivní panel; poslední vyplněné Repo ID / revize / složka zůstanou
- Přerušený více-souborový HF download už na Windows nepřekryje původní síťovou chybu zamčenou složkou: Studio instaluje hashovanou opravu downloaderu, která ukončí a dočká paralelní úlohy před cleanupem, zamčené mazání omezeně zopakuje a konkrétní přerušený soubor nejvýše dvakrát stáhne znovu od začátku
- Dlouhé stažení z Hugging Face přes Tabby už nespadne po 5 minutách na holé `fetch failed` (výchozí limit hlaviček undici). Studio nechá dokončit POST `/v1/download` a když spojení selže, session i UI ukážou lidskou příčinu (vypršení / přerušení), ne samotné `fetch failed`
- Stažení počká na skutečně zdravé TabbyAPI a souběžná rychlá kliknutí sdílejí jeden start; první požadavek už neodchází během startu serveru
- Adopted Tabby s neplatným runtime patchem se bezpečně opraví a restartuje; u externí instance se proces neukončuje, ale citlivé operace včetně HF downloadu blokují s lidskou chybou
- Tabulka lokálních Tabby modelů ukazovala u všech `0 B` a prázdný stav — API `/v1/model/list` velikost neposílá. Studio teď počítá reálnou velikost ze složky na disku, rozliší neznámou velikost (`—`) od prázdné `0 B` a nekompletní stažení označí stavem Nekompletní (Load vypnutý, smazání přes existující flow)

## [1.4.1] — 2026-08-28

### Added

- Při startu Studio pozná už běžící TabbyAPI na nakonfigurované adrese a osiřelou instanci z předchozího běhu převezme (včetně PID). Cizí službu na portu nepřivlastní ani neukončí — na stránce Server i v logu je stav vidět

## [1.4.0] — 2026-08-27

### Added

- Druhý backend **TabbyAPI** pro EXL3 modely (Windows): Studio spravuje oddělenou instalaci (výchozí `D:\AI\Tabby`), spouští `venv\Scripts\python.exe main.py`, přepíná se s Ollamou (vždy jen jeden aktivní)
- Katalog modelů z Tabby admin API, load dialog s cache bits, GPU split, vision a MTP přes `tabby_config.yml`
- Stažení z Hugging Face: složka se odvodí sama (`repo` / `repo-revision`), revize lze načíst z Hubu a progress ukazuje skutečná procenta podle velikosti souborů — když total nejde zjistit, zbývá neurčitý stav místo falešných %
- OpenCode provider `tabbyapi` (`@ai-sdk/openai-compatible`, `http://127.0.0.1:5000/v1`) — API klíč zapisuje main proces, admin klíč do konfigurace nejde
- Preflight Tabby instalace, fingerprint autentizace bez zobrazení klíčů, test rychlosti přes streamované `/v1/chat/completions`

### Changed

- Stránka Server, Layout a tray ukazují aktivní backend; stránka GPU/paměť popisuje procesy aktivního backendu (ne jen „Ollama“)
- Log parser a metriky requestů berou Tabby řádky `Received` / `Metrics` / `Finished`; chybějící telemetrie se nehádá

### Fixed

- Při přepnutí backendu se korektně zastaví jen Studiem vlastněný proces; cizí `python.exe` na portu se neukončuje
- Zástupce v nabídce Start a `OllamaStudio.exe` měly výchozí ikonu Electronu a hlásily se jako Electron 33.4.11; instalátor teď do binárky zapisuje ikonu i verzi aplikace
- Katalog modelů a admin operace Tabby končily chybou `401 Please provide an API key`. TabbyAPI ověřuje admin endpointy nejdřív API klíčem, takže Studio posílá `x-api-key` i `x-admin-key`
- Po přerušeném stažení z Hugging Face šlo znovu stáhnout jen ručním smazáním složky. Studio teď pozná existující složku, nabídne smazání, jiný název, nebo použití kompletního modelu — Tabby hlášku „path already exists“ už neukazuje jako syrové HTTP 400

## [1.3.3] — 2026-08-25

### Fixed

- První požadavek z OpenCode odstřelil běžící model a načetl ho znovu (osm sekund a keep-alive „navždy“ spadlo na serverový default). Studio při načtení posílalo `use_mmap: true`, kdežto Ollama na Windows s CUDA mmap sama vypíná, takže klient bez `options` si vyžádal jiný runner, než jaký běžel

### Changed

- Volba Try mmap v dialogu načtení už není zaškrtávátko, ale trojice Výchozí Ollama / Zapnuto / Vypnuto. Výchozí volba `use_mmap` vůbec neposílá, takže runner odpovídá tomu, co dostanou i klienti bez `options`. Uložené presety si svoji dřívější hodnotu ponechají

## [1.3.2] — 2026-08-25

### Fixed

- OpenCode kompaktoval session hned po první zprávě a model se přitom znovu načítal. Do konfigurace se zapisoval `limit.output` 32 000 tokenů i u 32k okna, takže OpenCode nechal na prompt necelý tisíc tokenů, zatímco jeho systémová zpráva s popisem nástrojů zabere přes 9 000. Output se teď drží na čtvrtině okna (u 32k tedy 8 192) a při aktualizaci se srazí i příliš velká hodnota z dřívějších verzí — ručně sníženou hodnotu zápis ponechá

## [1.3.1] — 2026-08-25

### Added

- Tlačítko Kopírovat v panelu logů zkopíruje do schránky právě zobrazené řádky včetně času, streamu a úrovně
- Po načtení modelu přes Load se test rychlosti spustí sám a výsledek se jen zapíše do tabulky; ruční spuštění z nabídky „…“ zůstává. Souběžné testy jednoho modelu se odmítnou, ať si na runneru nepřekážejí

### Fixed

- V logu i v klouzavém průměru na Přehledu se objevovalo 1 000 000 tok/s. Tuhle zástupnou hodnotu tiskne llama.cpp, když generování trvá naměřených 0 ms; nesmyslné rychlosti se teď zahazují a pomocné běhy testu rychlosti generují krátký text místo jediného tokenu
- CPU zátěž na stránce GPU a paměť skákala a neodpovídala Správci úloh (např. 28 % a 48 % při klidu okolo 10 %). Hodnota z WMI se počítala od poslední obnovy provideru, tedy přes neznámé okno; nově se bere průměr jádrových časů mezi obnovami stránky, takže odpadlo i spouštění PowerShellu na pozadí
- Rychlost zpracování promptu byla nadhodnocená (u modelů s dlouhou šablonou i o řád — např. 11 488 tok/s místo 420), protože Ollama hlásí počet tokenů za celý prompt, ale čas jen za ty, které nenašla v prompt cache. Nově se měří dvojicí delších běhů se společným prefixem, takže počet tokenů odpovídá naměřenému času

## [1.3.0] — 2026-08-24

### Added

- Test rychlosti u modelu změří TTFT, rychlost generování a rychlost zpracování promptu; spouští se z nabídky „…“ u modelu
- Test rychlosti měří až na načteném modelu po zahřívacím běhu, s unikátním promptem a deterministickým vzorkováním; načtení modelu se do TTFT nezapočítává a nepřepisuje keep_alive ani parametry běžícího runneru
- Tabulka načtených modelů má sloupce TTFT, Prompt a Odpověď s posledním naměřeným výsledkem; hodnoty přežijí přepnutí stránky a mizí při uvolnění modelu nebo restartu serve
- Stránka Server hlásí verzi Ollama a upozorní, když je na GitHubu novější vydání (odkaz otevře stránku vydání v prohlížeči)
- GPU a paměť rozlišuje jednotlivé grafické adaptéry: tabulka adaptérů (dedikovaná VRAM, využití, sdílená paměť, součet procesů, vytížení) a v tabulkách procesů sloupec pro každou kartu se zvlášť vypsanou pamětí. Na Windows se procesy k adaptéru přiřazují podle LUID z výkonnostních čítačů a jména se berou z DirectX registru, mimo Windows podle UUID karty z nvidia-smi
- Tabulky procesů na stránce GPU a paměť jdou řadit kliknutím na hlavičku sloupce (PID, proces, paměť na konkrétní kartě, celkem)

### Changed

- Načtené modely vypadají stejně na Přehledu, Využití zdrojů i na stránce Modely — všude je stejná tabulka s rozložením GPU/CPU a jednotnou nabídkou „…“ (parametry, test rychlosti, uvolnění)
- GitHub Actions release workflow používá checkout/setup-node v5, action-gh-release v3 a Node 22 (konec deprecation Node 20)

### Fixed

- Per-proces VRAM na stránce GPU a paměť ukazovala násobky skutečnosti (dwm třeba 9 GB na 16GB kartě). Čítač Dedicated Usage nahradil Local Usage, jehož součet přes procesy odpovídá nvidia-smi; díky tomu je vidět i integrovaná grafika, která žádnou dedikovanou paměť nemá

## [1.2.4] — 2026-08-24

### Fixed

- Po Stop debug / násilném ukončení aplikace už nezůstávají viset procesy llama-server: `ollama serve` běží v process-tree Electronu (Windows Job Object `KILL_ON_JOB_CLOSE`)

## [1.2.3] — 2026-08-18

### Fixed

- Balíček `.deb` v GitHub Release selhával na chybějícím maintainerovi; Linux release nyní obsahuje AppImage i `.deb`

## [1.2.2] — 2026-08-18

### Fixed

- Linuxový build v GitHub Release selhával na ikoně (`icon.ico` neměl 256×256); AppImage i `.deb` se nyní sestaví z PNG ikony

## [1.2.1] — 2026-08-18

### Added

- GitHub Actions workflow pro release Windows NSIS (a Linux AppImage a .deb) při tagu v*
- Zápis a aktualizace vybraného Ollama modelu do konfigurace OpenCode
- Indikátor stavu konfigurace Continue a OpenCode u každého modelu (přítomný a aktuální / neaktuální / chybí / nástroj nemá config)
- Historie požadavků na Přehledu eviduje načtení modelu (start, dokončení i chyba)

### Changed

- Linux GitHub Release obsahuje kromě AppImage i balíček `.deb`
- Akce u modelů: primární zůstaly Načíst a Uvolnit, ostatní (Continue, OpenCode, detail, klonování, smazání) jsou v menu dalších akcí
- Context, Details a export JSON rozlišují runtime, Modelfile a serverové defaulty; velikost v dialogu načtení je označená jako soubor na disku, ne VRAM
- Výchozí Context Length v dialogu načtení modelu teď odpovídá efektivnímu num_ctx (Modelfile PARAMETER, jinak OLLAMA_CONTEXT_LENGTH, omezeno architekturou)
- Výchozí filtr live logů je „Filtrované“ — skryje polling OllamaStudio (/api/ps, /api/version); „Vše“ ukáže kompletní výstup
- Filtry Load a Unload jsou sloučené do jednoho chipu Load/Unload
- Odstraněný vnější rámeček bloku serverových logů na Přehledu (zůstal jen rámeček logovací plochy)

### Fixed

- Výchozí výška logu na dashboardu odpovídá cca 12 řádkům; zbytečný scrollbar u krátkého obsahu zmizí
- Dialog načtení modelu už současně neukazuje TTL 30m i „ponechat v paměti“ — posílá se jen jedna hodnota keep_alive
- OpenCode po „Update in OpenCode“ padal na chybějícím limit.output — při zápisu se teď vždy doplní (výchozí 32 000 tokenů, ručně nastavená hodnota se zachová)

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
