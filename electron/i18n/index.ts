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
    killPidFailed: 'Ukončení PID {pid} selhalo',
    hfRepoIdEmpty: 'Zadejte Hugging Face Repo ID',
    hfUnauthorized: 'Hugging Face vyžaduje token (gated/private repo)',
    hfForbidden: 'Přístup k Hugging Face repozitáři byl odepřen',
    hfNotFound: 'Hugging Face repo nebylo nalezeno',
    hfRateLimited: 'Hugging Face dočasně odmítá požadavky (rate limit)',
    hfInvalidResponse: 'Hugging Face vrátilo neplatnou odpověď',
    hfNetwork: 'Hugging Face API je nedostupné',
    hfHttpError: 'Hugging Face API chyba (HTTP {status})',
    hfDownloadPathMissing: 'Stažení skončilo, ale cílovou složku se nepodařilo ověřit',
    hfFolderExists:
      'Složka „{folder}“ už existuje. Tabby do ní znovu stahovat neumí — smažte ji, nebo zvolte jiný název.',
    hfDeleteUnsafe: 'Mazání bylo odmítnuto — cesta není složka uvnitř adresáře modelů.',
    hfDeleteBusy:
      'Složku nelze smazat, protože je zamčená. Uvolněte model a zkuste to znovu.',
    hfDeleteFailed: 'Složku se nepodařilo smazat',
    connRefused: 'Server neběží nebo neposlouchá na {target}',
    timedOut: 'Spojení na {target} vypršelo',
    connReset: 'Spojení na {target} bylo přerušeno',
    dnsFailed: 'Adresu {target} se nepodařilo přeložit',
    aborted: 'Požadavek na {target} byl přerušen',
    httpStatus: 'Server {target} odpověděl HTTP {status}',
    networkFailed: 'Síťové volání selhalo ({detail})',
    ipcRepeat: ' (opakováno {count}×)',
    tabbyStoppedUnexpectedly: 'Proces TabbyAPI se neočekávaně ukončil',
    hfDownloadBackendLost:
      'Tabby server přestal odpovídat, stahování bylo přerušeno ({downloaded} z {total})',
    tabbyPortBusy:
      'Na {host}:{port} poslouchá jiná služba, ne TabbyAPI. Studio ji neukončí a Tabby nespouští.',
    tabbyAdopted: 'Převzata běžící TabbyAPI (PID {pid}) na {endpoint}',
    tabbyExternal:
      'TabbyAPI už běží na {endpoint}, ale nejde o instanci Studia — proces se nepřebírá ani se při ukončení nezastaví',
    tabbyExternalStop: 'Externí TabbyAPI nelze zastavit ze Studia (proces nevlastníme).',
    tabbyExternalRestart: 'Externí TabbyAPI nelze restartovat ze Studia.'
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
    killPidFailed: 'Killing PID {pid} failed',
    hfRepoIdEmpty: 'Enter a Hugging Face repo ID',
    hfUnauthorized: 'Hugging Face requires a token (gated/private repo)',
    hfForbidden: 'Access to the Hugging Face repository was denied',
    hfNotFound: 'Hugging Face repo was not found',
    hfRateLimited: 'Hugging Face is temporarily rate-limiting requests',
    hfInvalidResponse: 'Hugging Face returned an invalid response',
    hfNetwork: 'Hugging Face API is unreachable',
    hfHttpError: 'Hugging Face API error (HTTP {status})',
    hfDownloadPathMissing: 'Download finished but the target folder could not be verified',
    hfFolderExists:
      'Folder “{folder}” already exists. Tabby cannot download into it again — delete it or choose a different name.',
    hfDeleteUnsafe: 'Delete refused — the path is not a folder inside the models directory.',
    hfDeleteBusy: 'The folder cannot be deleted because it is locked. Unload the model and try again.',
    hfDeleteFailed: 'The folder could not be deleted',
    connRefused: 'The server is not running or not listening on {target}',
    timedOut: 'Connection to {target} timed out',
    connReset: 'Connection to {target} was reset',
    dnsFailed: 'Could not resolve {target}',
    aborted: 'Request to {target} was aborted',
    httpStatus: 'Server {target} responded with HTTP {status}',
    networkFailed: 'Network request failed ({detail})',
    ipcRepeat: ' (repeated {count}×)',
    tabbyStoppedUnexpectedly: 'The TabbyAPI process exited unexpectedly',
    hfDownloadBackendLost:
      'The Tabby server stopped responding; the download was interrupted ({downloaded} of {total})',
    tabbyPortBusy:
      'Another service is listening on {host}:{port}, not TabbyAPI. Studio will not stop it or start Tabby.',
    tabbyAdopted: 'Adopted a running TabbyAPI (PID {pid}) at {endpoint}',
    tabbyExternal:
      'TabbyAPI is already running at {endpoint}, but this is not a Studio instance — it will not be adopted or stopped on exit',
    tabbyExternalStop: 'External TabbyAPI cannot be stopped from Studio (process is not owned).',
    tabbyExternalRestart: 'External TabbyAPI cannot be restarted from Studio.'
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
