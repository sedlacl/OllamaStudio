---
name: ollamastudio-mcp
description: >-
  Navádí optimalizaci a debugging modelů Ollama/Tabby přes lokální OllamaStudio MCP
  (profily, GPU/VRAM/RAM, logy, load/unload, test query, benchmark).
  Použít při OllamaStudio, diagnostice Ollama nebo Tabby, ladění model profiles,
  resource metrikách, get_logs, run_test_query nebo run_speed_test.
---

# OllamaStudio MCP

Předpoklad: běží OllamaStudio s povoleným MCP na `127.0.0.1` (typicky port 3847). Token nikdy necommituj ani nepiš do chatu — používá se env `OLLAMA_STUDIO_MCP_TOKEN`.

## Workflow

1. **`studio_status`** — ověř verzi, aktivní backend, serve state a capabilities.
2. **Pozorování před mutací** — `get_resources`, `get_model` / `get_model_profile`, volitelně `get_logs`, `list_models`, `get_acquisitions`, `integrations_status`.
3. **Změna profilu** — uprav parametry, pak **`save_model_profile`**. Po změně, která vyžaduje nové načtení: **`unload_model`** → **`load_model`** (nebo `restart_server` jen když to uživatel výslovně chce).
4. **Ověření** — **`run_test_query`** (krátký prompt, TTFT/TPS pokud backend vrátí) a **`run_speed_test`**. Porovnej metriky s předchozím stavem (TPS, latence, VRAM/RAM z `get_resources`).
5. **Backend / preset** — globální env přes `save_backend_settings`; opakované load scénáře přes `list_presets` / `save_preset`.

## Destruktivní a citlivé operace

Volat **jen na explicitní žádost uživatele**: `stop_server`, `restart_server`, `switch_backend`, `delete_model`, `kill_process`, `remove_continue_model`, `remove_opencode_model`, `delete_preset`. `acquire_model` a `copy_model` jen s potvrzením rozsahu.

## Bezpečnost

- Nevypisuj MCP bearer token, HF tokeny ani obsah `Authorization` z konfigurace.
- V odpovědích neopakuj raw secrety z tool výstupů (Studio je rediguje; stejně nešir).

## Rychlá mapa toolů

| Účel | Tooly |
|------|--------|
| Stav | `studio_status`, `integrations_status` |
| Metriky | `get_resources` |
| Logy | `get_logs` |
| Modely | `list_models`, `get_model`, `get_model_profile`, `save_model_profile` |
| Runtime | `load_model`, `unload_model`, `run_speed_test`, `run_test_query` |
| Stahování | `get_acquisitions`, `acquire_model` |
| Admin | `start_server`, `save_backend_settings`, presety, Continue/OpenCode helpers |
