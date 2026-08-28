import { execFile, type ChildProcess } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import net from 'net'
import { promisify } from 'util'
import { app } from 'electron'
import { tMain } from '../i18n'
import {
  loadConfig,
  resolveTabbyConfigPath,
  resolveTabbyPython,
  saveConfig,
  type AppConfig,
  type TabbyConfig
} from '../ollama/config'
import { logBuffer } from '../ollama/log-buffer'
import { openStudioLogWriter, closeStudioLogWriter } from '../security/studio-log-persistence'
import { sanitizeOptionalError } from '../security/sanitize-state'
import { tabbyClient } from './client'
import { noteBackendLost, resanitizeDownloadSessionSnapshot } from './download-session'
import { setTabbyPatchReadiness } from './patch-readiness'
import { getTabbyAuthFingerprint, registerTabbyAuthSecrets, readTabbyAuth, watchTabbyAuth } from './auth'
import type { BackendServeState, EndpointStatus, ProcessStatus } from '../backends/types'
import { spawn } from 'child_process'
import {
  classifyListenerProbe,
  decideTabbyStart,
  parseOwnedPidRecord,
  validateStoredPid,
  type LiveProcessInfo,
  type StoredOwnedPid,
  type TabbyStartAction
} from './adopt-helpers'
import { SingleFlight, waitForHealthy } from './readiness'
import {
  applyTabbyRuntimePatches,
  TABBY_RUNTIME_PATCH_VERSION,
  verifyTabbyRuntimePatchIntegrity
} from './runtime-patch'

const execFileAsync = promisify(execFile)

type StatusListener = (state: BackendServeState) => void

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as NodeJS.ErrnoException).code)
        : ''
    return code === 'EPERM'
  }
}

function ownedPidPath(): string {
  return join(app.getPath('userData'), 'tabby-owned.json')
}

async function queryLiveProcess(pid: number): Promise<LiveProcessInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (!pidAlive(pid)) {
    return { pid, alive: false, commandLine: null, creationTimeMs: null }
  }
  if (process.platform !== 'win32') {
    return { pid, alive: true, commandLine: null, creationTimeMs: null }
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if(-not $p){ '' } else { $ms=[int64]([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds(); @{ pid=$p.ProcessId; commandLine=$p.CommandLine; startedAtMs=$ms } | ConvertTo-Json -Compress }`
      ],
      { windowsHide: true, timeout: 8000 }
    )
    const trimmed = stdout.trim()
    if (!trimmed) return { pid, alive: true, commandLine: null, creationTimeMs: null }
    const parsed = JSON.parse(trimmed) as {
      commandLine?: unknown
      startedAtMs?: unknown
    }
    return {
      pid,
      alive: true,
      commandLine: typeof parsed.commandLine === 'string' ? parsed.commandLine : null,
      creationTimeMs:
        typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs)
          ? parsed.startedAtMs
          : null
    }
  } catch {
    return { pid, alive: true, commandLine: null, creationTimeMs: null }
  }
}

export interface TabbyPreflightResult {
  ok: boolean
  installDir: string
  pythonPath: string
  configPath: string
  mainPy: string
  errors: string[]
  warnings: string[]
}

export function preflightTabby(tabby?: TabbyConfig): TabbyPreflightResult {
  const cfg = tabby ?? loadConfig().tabby!
  const installDir = cfg.installDir.trim()
  const pythonPath = resolveTabbyPython(cfg)
  const configPath = resolveTabbyConfigPath(cfg)
  const mainPy = join(installDir, 'main.py')
  const errors: string[] = []
  const warnings: string[] = []

  if (!installDir) errors.push('Tabby installDir is empty')
  if (!existsSync(installDir)) errors.push(`Install dir missing: ${installDir}`)
  if (!existsSync(mainPy)) errors.push(`main.py missing: ${mainPy}`)
  if (!existsSync(pythonPath)) {
    errors.push(
      `Python venv missing: ${pythonPath}. Create it with uv (do not run start.bat from Studio).`
    )
  }
  if (!existsSync(configPath)) {
    warnings.push(`config.yml missing at ${configPath} — Tabby will use defaults`)
  }

  return {
    ok: errors.length === 0,
    installDir,
    pythonPath,
    configPath,
    mainPy,
    errors,
    warnings
  }
}

export class TabbyServeManager {
  private process: ChildProcess | null = null
  private processStatus: ProcessStatus = 'stopped'
  private endpointStatus: EndpointStatus = 'unreachable'
  private pid: number | null = null
  private spawnTime: number | null = null
  private binaryPath: string | null = null
  private error: string | null = null
  private portConflict = false
  private ownedByStudio = false
  private adoptedExisting = false
  private listeners = new Set<StatusListener>()
  private readonly startGate = new SingleFlight()
  private readonly readinessGate = new SingleFlight()
  private runtimePatchLoaded = false
  private authWatchRelease: (() => void) | null = null

  constructor() {
    /* log writer se otevře až po registraci secretů a dokončeném scrubu (start/adopt) */
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getPid(): number | null {
    return this.pid
  }

  getSpawnTime(): number | null {
    return this.spawnTime
  }

  /**
   * PIDy spravovaného serve stromu (serve + potomci).
   * Nepoužívat globální filtr `python.exe` — jen vlastněný strom.
   */
  async getManagedPids(): Promise<number[]> {
    if (!this.ownedByStudio || this.pid == null) return []
    const root = this.pid
    if (process.platform !== 'win32') return [root]
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$root=${root}; $set=New-Object 'System.Collections.Generic.HashSet[int]'; [void]$set.Add($root); $q=New-Object System.Collections.Queue; $q.Enqueue($root); while($q.Count -gt 0){ $p=[int]$q.Dequeue(); Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" -ErrorAction SilentlyContinue | ForEach-Object { if($set.Add([int]$_.ProcessId)){ $q.Enqueue([int]$_.ProcessId) } } }; ($set | Sort-Object) -join ','`
        ],
        { windowsHide: true, timeout: 8000 }
      )
      const pids = stdout
        .trim()
        .split(',')
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0)
      return pids.length > 0 ? pids : [root]
    } catch {
      return [root]
    }
  }

  isRunning(): boolean {
    return this.processStatus === 'running' || this.processStatus === 'starting'
  }

  getState(): BackendServeState {
    this.reconcileAdoptedLiveness()
    const auth = getTabbyAuthFingerprint()
    const status =
      this.processStatus === 'failed'
        ? 'error'
        : this.processStatus === 'external'
          ? this.endpointStatus === 'healthy'
            ? 'running'
            : 'error'
          : (this.processStatus as BackendServeState['status'])

    return {
      backend: 'tabby',
      processStatus: this.processStatus,
      endpointStatus: this.endpointStatus,
      status,
      pid: this.pid,
      spawnTime: this.spawnTime,
      binaryPath: this.binaryPath,
      error: this.error,
      portConflict: this.portConflict,
      ownedByStudio: this.ownedByStudio,
      adoptedExisting: this.adoptedExisting,
      auth: {
        hasApiKey: auth.hasApiKey,
        hasAdminKey: auth.hasAdminKey,
        disableAuth: auth.disableAuth
      }
    }
  }

  private emit(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }

  private setPartial(partial: {
    processStatus?: ProcessStatus
    endpointStatus?: EndpointStatus
    pid?: number | null
    spawnTime?: number | null
    binaryPath?: string | null
    error?: string | null
    portConflict?: boolean
    ownedByStudio?: boolean
    adoptedExisting?: boolean
  }): void {
    if (partial.processStatus !== undefined) this.processStatus = partial.processStatus
    if (partial.endpointStatus !== undefined) this.endpointStatus = partial.endpointStatus
    if (partial.pid !== undefined) this.pid = partial.pid
    if (partial.spawnTime !== undefined) this.spawnTime = partial.spawnTime
    if (partial.binaryPath !== undefined) this.binaryPath = partial.binaryPath
    if (partial.error !== undefined) {
      this.error = sanitizeOptionalError(partial.error) ?? null
    }
    if (partial.portConflict !== undefined) this.portConflict = partial.portConflict
    if (partial.ownedByStudio !== undefined) this.ownedByStudio = partial.ownedByStudio
    if (partial.adoptedExisting !== undefined) this.adoptedExisting = partial.adoptedExisting
    this.emit()
    setTabbyPatchReadiness({
      externalProcess: this.processStatus === 'external',
      runtimePatchValid: this.runtimePatchLoaded
    })
  }

  async checkPortInUse(): Promise<boolean> {
    const cfg = loadConfig().tabby!
    return new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(true))
      server.once('listening', () => {
        server.close(() => resolve(false))
      })
      server.listen(cfg.port, cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host)
    })
  }

  /**
   * Při startu Studia / zapnutí backendu: převeď osiřelou Tabby, připoj cizí
   * Tabby jako external, nebo ohlas konflikt. Nespawnuje nový proces.
   */
  async adoptOrDetect(): Promise<void> {
    if (this.processStatus === 'starting' || this.processStatus === 'running') return
    await this.resolveStartDecision()
  }

  /** @deprecated použij adoptOrDetect — ponecháno pro stávající volání. */
  async detectExternal(): Promise<boolean> {
    await this.adoptOrDetect()
    return this.processStatus === 'external' || this.processStatus === 'running'
  }

  async refreshEndpoint(): Promise<void> {
    tabbyClient.refresh()
    try {
      const health = await tabbyClient.getHealth()
      this.setPartial({
        endpointStatus: health.status === 'healthy' ? 'healthy' : 'degraded'
      })
    } catch {
      if (this.processStatus === 'running' || this.processStatus === 'external') {
        this.setPartial({ endpointStatus: 'unreachable' })
      }
    }
  }

  async start(forceKillConflict = false): Promise<void> {
    return this.startGate.run(() => this.startOnce(forceKillConflict))
  }

  private async startOnce(_forceKillConflict = false): Promise<void> {
    if (this.processStatus === 'starting' || this.processStatus === 'running') return

    const action = await this.resolveStartDecision()
    if (action !== 'spawn') return

    const pre = preflightTabby()
    if (!pre.ok) {
      this.setPartial({
        processStatus: 'failed',
        error: pre.errors.join('; '),
        binaryPath: pre.pythonPath
      })
      return
    }

    const patchResults = applyTabbyRuntimePatches(pre.installDir)
    const failed = patchResults.find((result) => !result.ok)
    if (failed) {
      const unsupported = failed.status === 'unsupported-source'
      const message = unsupported
        ? tMain('errors.tabbyPatchUnsupported')
        : tMain('errors.tabbyPatchFailed')
      logBuffer.appendApp(
        'error',
        `[studio] tabby-runtime-patch version=${failed.version} target=${failed.target} status=${failed.status}`
      )
      this.setPartial({
        processStatus: 'failed',
        endpointStatus: 'unreachable',
        error: message,
        binaryPath: pre.pythonPath
      })
      return
    }
    const applied = patchResults.find((result) => result.status === 'applied')
    if (applied) {
      logBuffer.appendApp(
        'info',
        `[studio] tabby-runtime-patch version=${applied.version} status=applied`
      )
    }
    registerTabbyAuthSecrets()
    this.startAuthWatcher(pre.installDir)
    this.runtimePatchLoaded = true

    const portBusy = await this.checkPortInUse()
    if (portBusy) {
      const retry = await this.resolveStartDecision()
      if (retry !== 'spawn') return
      const cfg = loadConfig().tabby!
      this.applyConflict(cfg.host, cfg.port)
      return
    }

    this.clearOwnedPid()
    this.setPartial({
      processStatus: 'starting',
      endpointStatus: 'unreachable',
      error: null,
      portConflict: false,
      binaryPath: pre.pythonPath,
      pid: null,
      spawnTime: null,
      ownedByStudio: true,
      adoptedExisting: false
    })

    try {
      await openStudioLogWriter(join(app.getPath('userData'), 'logs'), 'tabby-serve.log')
      this.process = spawn(pre.pythonPath, [pre.mainPy], {
        cwd: pre.installDir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false
      })

      const pid = this.process.pid ?? null
      const startedAt = Date.now()
      // Tabby se záměrně nepřipojuje k Job Object KILL_ON_JOB_CLOSE
      // (process-tree.ts). Ten je pro Ollama llama-server sirotky. Kdybychom
      // Tabby do jobu dali, electron-vite restart main procesu (dev) by při
      // probíhajícím HF stahování Tabby i download zabil.
      this.setPartial({ pid, spawnTime: startedAt })
      if (pid != null) this.writeOwnedPid(pid, startedAt, pre.pythonPath, pre.installDir)

      this.process.stdout?.on('data', (chunk: Buffer) => {
        logBuffer.appendChunk('stdout', chunk)
      })
      this.process.stderr?.on('data', (chunk: Buffer) => {
        logBuffer.appendChunk('stderr', chunk)
      })

      this.process.on('error', (err) => {
        this.runtimePatchLoaded = false
        this.clearOwnedPid()
        this.setPartial({
          processStatus: 'failed',
          error: sanitizeOptionalError(err.message) ?? tMain('errors.tabbyStoppedUnexpectedly'),
          pid: null,
          spawnTime: null,
          ownedByStudio: false,
          adoptedExisting: false
        })
        this.process = null
      })

      this.process.on('exit', (code, signal) => {
        logBuffer.flushAll()
        this.runtimePatchLoaded = false
        this.clearOwnedPid()
        if (this.processStatus !== 'stopping') {
          const msg =
            code !== null && code !== 0
              ? tMain('errors.processExitedCode', { code })
              : signal
                ? tMain('errors.processExitedSignal', { signal })
                : tMain('errors.tabbyStoppedUnexpectedly')
          logBuffer.appendApp('error', `[studio] tabby-serve: ${msg}`)
          noteBackendLost()
          this.setPartial({
            processStatus: msg ? 'failed' : 'stopped',
            endpointStatus: 'unreachable',
            error: msg,
            pid: null,
            spawnTime: null,
            ownedByStudio: false,
            adoptedExisting: false
          })
        } else {
          this.setPartial({
            processStatus: 'stopped',
            endpointStatus: 'unreachable',
            pid: null,
            spawnTime: null,
            error: null,
            ownedByStudio: false,
            adoptedExisting: false
          })
        }
        this.process = null
      })

      await this.waitForReady(180000)
      tabbyClient.refresh()
      registerTabbyAuthSecrets()
      this.setPartial({
        processStatus: 'running',
        endpointStatus: 'healthy',
        error: null
      })
    } catch (err) {
      this.runtimePatchLoaded = false
      await this.killProcess()
      this.clearOwnedPid()
      this.setPartial({
        processStatus: 'failed',
        endpointStatus: 'unreachable',
        error: sanitizeOptionalError(err instanceof Error ? err.message : String(err)) ?? null,
        pid: null,
        spawnTime: null,
        ownedByStudio: false,
        adoptedExisting: false
      })
    }
  }

  async ensureReady(timeoutMs = 180000): Promise<void> {
    return this.readinessGate.run(async () => {
      if (!(await this.isEndpointHealthy())) {
        await this.start()
      }
      if (!this.runtimePatchLoaded) {
        if (this.ownedByStudio) {
          await this.restart()
        } else {
          throw new Error(tMain('errors.tabbyPatchRestartRequired'))
        }
      }
      await this.waitForReady(timeoutMs)
    })
  }

  async stop(): Promise<void> {
    if (this.processStatus === 'external') {
      this.setPartial({
        error: tMain('errors.tabbyExternalStop')
      })
      return
    }
    if (!this.process && !(this.ownedByStudio && this.pid != null)) {
      this.setPartial({
        processStatus: 'stopped',
        endpointStatus: 'unreachable',
        pid: null,
        spawnTime: null,
        ownedByStudio: false,
        adoptedExisting: false
      })
      return
    }
    this.setPartial({ processStatus: 'stopping' })
    await this.killProcess()
    logBuffer.flushAll()
    this.clearOwnedPid()
    this.setPartial({
      processStatus: 'stopped',
      endpointStatus: 'unreachable',
      pid: null,
      spawnTime: null,
      error: null,
      ownedByStudio: false,
      adoptedExisting: false
    })
  }

  async restart(forceKillConflict = false): Promise<void> {
    if (this.processStatus === 'external') {
      this.setPartial({
        error: tMain('errors.tabbyExternalRestart')
      })
      return
    }
    await this.stop()
    await this.start(forceKillConflict)
  }

  async saveConfigAndRestart(config: AppConfig): Promise<void> {
    saveConfig(config)
    tabbyClient.refresh()
    if (this.isRunning() && this.ownedByStudio) {
      await this.restart()
    }
  }

  async shutdown(): Promise<void> {
    this.authWatchRelease?.()
    this.authWatchRelease = null
    if (this.ownedByStudio) await this.stop()
    closeStudioLogWriter()
  }

  private startAuthWatcher(installDir: string): void {
    this.authWatchRelease?.()
    const cfg = loadConfig().tabby!
    this.authWatchRelease = watchTabbyAuth(() => {
      try {
        resanitizeDownloadSessionSnapshot()
      } catch {
        /* download store may be unconfigured in tests */
      }
    }, { ...cfg, installDir })
  }

  private refreshRuntimePatchState(installDir: string, owned: boolean): boolean {
    const integrity = verifyTabbyRuntimePatchIntegrity(installDir)
    if (integrity.ok) {
      this.runtimePatchLoaded = true
      setTabbyPatchReadiness({
        externalProcess: !owned,
        runtimePatchValid: true
      })
      return true
    }
    this.runtimePatchLoaded = false
    setTabbyPatchReadiness({
      externalProcess: !owned,
      runtimePatchValid: false
    })
    if (owned) {
      logBuffer.appendApp(
        'warn',
        `[studio] tabby-runtime-patch integrity failed targets=${integrity.invalidTargets.join(',')}`
      )
    } else {
      this.setPartial({
        error: tMain('errors.tabbyPatchRestartRequired')
      })
    }
    return false
  }

  private async resolveStartDecision(): Promise<TabbyStartAction> {
    const cfg = loadConfig().tabby!
    const pythonPath = resolveTabbyPython(cfg)
    const endpoint = `${cfg.host}:${cfg.port}`
    tabbyClient.refresh()
    const portBusy = await this.checkPortInUse()
    if (!portBusy) return 'spawn'

    const probe = await tabbyClient.probeListener()
    const listener = classifyListenerProbe({
      portBusy,
      healthReached: probe.healthReached,
      healthHttpStatus: probe.healthHttpStatus,
      healthJson: probe.healthJson,
      modelReached: probe.modelReached,
      modelHttpStatus: probe.modelHttpStatus,
      modelJson: probe.modelJson
    })
    const stored = this.readOwnedPid()
    const live = stored ? await queryLiveProcess(stored.pid) : null
    const pidCheck = validateStoredPid(stored, live, {
      host: cfg.host,
      port: cfg.port,
      installDir: cfg.installDir,
      pythonPath
    })
    const action = decideTabbyStart({ listener, pidCheck })

    if (action === 'adopt' && stored) {
      this.applyAdopt(stored, pythonPath, endpoint)
    } else if (action === 'attach-external') {
      this.clearOwnedPid()
      this.applyExternal(pythonPath, endpoint)
    } else if (action === 'conflict') {
      if (pidCheck !== 'match') this.clearOwnedPid()
      this.applyConflict(cfg.host, cfg.port)
    }
    return action
  }

  private applyAdopt(stored: StoredOwnedPid, pythonPath: string, endpoint: string): void {
    this.process = null
    this.setPartial({
      processStatus: 'running',
      endpointStatus: 'healthy',
      ownedByStudio: true,
      adoptedExisting: true,
      pid: stored.pid,
      spawnTime: stored.startedAtMs,
      binaryPath: pythonPath,
      error: null,
      portConflict: false
    })
    registerTabbyAuthSecrets()
    this.startAuthWatcher(stored.installDir)
    const patched = this.refreshRuntimePatchState(stored.installDir, true)
    if (!patched) {
      void this.repairAdoptedPatchAndRestart(stored.installDir)
    }
    logBuffer.appendApp(
      'info',
      `[studio] tabby-serve: ${tMain('errors.tabbyAdopted', { pid: stored.pid, endpoint })}`
    )
  }

  private async repairAdoptedPatchAndRestart(installDir: string): Promise<void> {
    const results = applyTabbyRuntimePatches(installDir)
    if (results.some((result) => !result.ok)) return
    if (this.ownedByStudio && this.processStatus === 'running') {
      await this.restart()
    }
  }

  private applyExternal(pythonPath: string, endpoint: string): void {
    this.process = null
    const installDir = loadConfig().tabby!.installDir.trim()
    this.refreshRuntimePatchState(installDir, false)
    this.setPartial({
      processStatus: 'external',
      endpointStatus: 'healthy',
      ownedByStudio: false,
      adoptedExisting: false,
      pid: null,
      spawnTime: null,
      error: this.runtimePatchLoaded ? null : tMain('errors.tabbyPatchRestartRequired'),
      portConflict: false,
      binaryPath: pythonPath
    })
    registerTabbyAuthSecrets()
    this.startAuthWatcher(installDir)
    logBuffer.appendApp(
      'warn',
      `[studio] tabby-serve: ${tMain('errors.tabbyExternal', { endpoint })}`
    )
  }

  private applyConflict(host: string, port: number): void {
    this.setPartial({
      processStatus: 'failed',
      endpointStatus: 'unreachable',
      ownedByStudio: false,
      adoptedExisting: false,
      pid: null,
      spawnTime: null,
      // Žádný kill — Layout tlačítko „ukončit konflikt“ se u Tabby nesmí objevit.
      portConflict: false,
      error: tMain('errors.tabbyPortBusy', { host, port })
    })
    logBuffer.appendApp(
      'error',
      `[studio] tabby-serve: ${tMain('errors.tabbyPortBusy', { host, port })}`
    )
  }

  private readOwnedPid(): StoredOwnedPid | null {
    try {
      const raw = JSON.parse(readFileSync(ownedPidPath(), 'utf-8')) as unknown
      return parseOwnedPidRecord(raw)
    } catch {
      return null
    }
  }

  private writeOwnedPid(
    pid: number,
    startedAtMs: number,
    pythonPath: string,
    installDir: string
  ): void {
    const cfg = loadConfig().tabby!
    const record: StoredOwnedPid = {
      pid,
      host: cfg.host,
      port: cfg.port,
      pythonPath,
      installDir,
      startedAtMs,
      runtimePatchVersion: TABBY_RUNTIME_PATCH_VERSION
    }
    try {
      const path = ownedPidPath()
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(record), 'utf-8')
      renameSync(tmp, path)
    } catch {
      /* persistence is best-effort — next start will treat Tabby as external */
    }
  }

  private clearOwnedPid(): void {
    try {
      unlinkSync(ownedPidPath())
    } catch {
      /* missing is fine */
    }
  }

  private reconcileAdoptedLiveness(): void {
    if (!this.ownedByStudio || this.process != null || this.pid == null) return
    if (this.processStatus !== 'running' && this.processStatus !== 'starting') return
    if (pidAlive(this.pid)) return
    this.clearOwnedPid()
    this.processStatus = 'stopped'
    this.endpointStatus = 'unreachable'
    this.pid = null
    this.spawnTime = null
    this.ownedByStudio = false
    this.adoptedExisting = false
    this.runtimePatchLoaded = false
    this.error = null
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const healthy = await waitForHealthy({
      timeoutMs,
      intervalMs: 250,
      probe: async () => {
        if (this.processStatus === 'failed') {
          throw new Error(this.error ?? tMain('errors.serverTimeout'))
        }
        return this.isEndpointHealthy()
      }
    })
    if (!healthy) throw new Error(tMain('errors.serverTimeout'))
  }

  private async isEndpointHealthy(): Promise<boolean> {
    tabbyClient.refresh()
    try {
      const health = await tabbyClient.getHealth()
      return health.status === 'healthy'
    } catch {
      return false
    }
  }

  private async killProcess(): Promise<void> {
    const proc = this.process
    const pid = proc?.pid ?? this.pid
    if ((!proc || proc.killed) && pid == null) {
      this.process = null
      return
    }

    if (process.platform === 'win32' && pid) {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true
        })
      } catch {
        try {
          proc?.kill('SIGTERM')
        } catch {
          /* already gone */
        }
      }
    } else {
      proc?.kill('SIGTERM')
    }

    if (proc) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            if (!proc.killed) proc.kill('SIGKILL')
          } catch {
            /* already gone */
          }
          resolve()
        }, 8000)
        proc.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    } else if (pid != null) {
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && pidAlive(pid)) {
        await sleep(200)
      }
    }

    this.process = null
  }

  isExternalProcess(): boolean {
    return this.processStatus === 'external'
  }
}

export const tabbyServeManager = new TabbyServeManager()
