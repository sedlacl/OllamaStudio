import { DEFAULT_LOCALE, isLocale, type Locale } from './types'

type Vars = Record<string, string | number>

const csMessages = {
  tray: {
    tooltip: 'OllamaStudio — {status} | načteno: {count}',
    tooltipStopped: 'OllamaStudio — zastaveno',
    show: 'Zobrazit OllamaStudio',
    startServe: 'Spustit serve',
    stopServe: 'Zastavit serve',
    restartServe: 'Restartovat serve',
    quit: 'Ukončit OllamaStudio',
    statusRunning: 'běží',
    statusStarting: 'spouští se',
    statusStopping: 'zastavuje se',
    statusError: 'chyba',
    statusStopped: 'zastaveno'
  },
  errors: {
    ollamaMissing: 'Ollama CLI nebylo nalezeno. Nainstalujte Ollama a přidejte do PATH.',
    portBusy:
      'Port 11434 je obsazený. Ukončete systémovou Ollamu (tray → Quit) nebo potvrďte ukončení konfliktních procesů.',
    serverTimeout: 'Server neodpovídá v časovém limitu',
    presetNameEmpty: 'Název presetu nesmí být prázdný',
    invalidJson: 'Neplatný JSON',
    jsonMustBeObject: 'JSON musí být objekt',
    presetKindMismatch: 'Preset je typu „{kind}“, očekáváno „{expected}“',
    missingData: 'Chybí pole data',
    importName: 'Import {when}',
    modelNameEmpty: 'Název modelu nesmí být prázdný',
    continueInvalidConfig: 'Continue config.yaml nelze přečíst — soubor je poškozený',
    opencodeInvalidConfig: 'OpenCode opencode.json nelze přečíst — soubor je poškozený',
    modelAlreadyLoading: 'Model „{name}" se už načítá',
    speedTestRunning: 'Test rychlosti modelu „{name}" už běží',
    processExitedCode: 'Proces skončil s kódem {code}',
    processExitedSignal: 'Proces ukončen signálem {signal}',
    invalidPid: 'Neplatné PID',
    cannotKillSelf: 'Nelze ukončit vlastní proces aplikace',
    stopServeFailed: 'Ukončení serve selhalo',
    processGone: 'Proces {pid} už neběží',
    notOllamaProcess: 'PID {pid} ({name}) není Ollama / llama runner — ukončení odmítnuto',
    killPidFailed: 'Ukončení PID {pid} selhalo'
  }
} as const

type WidenStrings<T> = T extends string
  ? string
  : { [K in keyof T]: WidenStrings<T[K]> }

type MainMessages = WidenStrings<typeof csMessages>

const enMessages: MainMessages = {
  tray: {
    tooltip: 'OllamaStudio — {status} | loaded: {count}',
    tooltipStopped: 'OllamaStudio — stopped',
    show: 'Show OllamaStudio',
    startServe: 'Start serve',
    stopServe: 'Stop serve',
    restartServe: 'Restart serve',
    quit: 'Quit OllamaStudio',
    statusRunning: 'running',
    statusStarting: 'starting',
    statusStopping: 'stopping',
    statusError: 'error',
    statusStopped: 'stopped'
  },
  errors: {
    ollamaMissing: 'Ollama CLI was not found. Install Ollama and add it to PATH.',
    portBusy:
      'Port 11434 is in use. Quit system Ollama (tray → Quit) or confirm killing conflicting processes.',
    serverTimeout: 'Server did not respond within the time limit',
    presetNameEmpty: 'Preset name must not be empty',
    invalidJson: 'Invalid JSON',
    jsonMustBeObject: 'JSON must be an object',
    presetKindMismatch: 'Preset is of kind “{kind}”, expected “{expected}”',
    missingData: 'Missing data field',
    importName: 'Import {when}',
    modelNameEmpty: 'Model name must not be empty',
    continueInvalidConfig: 'Continue config.yaml cannot be read — the file is corrupt',
    opencodeInvalidConfig: 'OpenCode opencode.json cannot be read — the file is corrupt',
    modelAlreadyLoading: 'Model “{name}” is already loading',
    speedTestRunning: 'A speed test for model “{name}” is already running',
    processExitedCode: 'Process exited with code {code}',
    processExitedSignal: 'Process was terminated by signal {signal}',
    invalidPid: 'Invalid PID',
    cannotKillSelf: 'Cannot kill the application’s own process',
    stopServeFailed: 'Stopping serve failed',
    processGone: 'Process {pid} is no longer running',
    notOllamaProcess: 'PID {pid} ({name}) is not an Ollama / llama runner — kill refused',
    killPidFailed: 'Killing PID {pid} failed'
  }
}

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never
type Paths<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string ? K : Join<K, Paths<T[K]>>
    }[keyof T & string]

export type MainMessageKey = Paths<MainMessages>

const catalogs: Record<Locale, MainMessages> = {
  cs: csMessages,
  en: enMessages
}

let currentLocale: Locale = DEFAULT_LOCALE

export function getMainLocale(): Locale {
  return currentLocale
}

export function setMainLocale(locale: Locale): void {
  if (isLocale(locale)) currentLocale = locale
}

function resolvePath(tree: MainMessages, key: MainMessageKey): string {
  const parts = key.split('.')
  let node: unknown = tree
  for (const part of parts) {
    if (!node || typeof node !== 'object' || !(part in node)) return key
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : key
}

export function tMain(key: MainMessageKey, vars?: Vars): string {
  let text = resolvePath(catalogs[currentLocale] ?? catalogs[DEFAULT_LOCALE], key)
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

export { DEFAULT_LOCALE, isLocale, type Locale }
