import { execFile, type ChildProcess } from 'child_process'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
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
import {
  attachServeProcessTree,
  type ServeProcessTree
} from '../ollama/process-tree'
import { tabbyClient } from './client'
import { getTabbyAuthFingerprint, readTabbyAuth } from './auth'
import type { BackendServeState, EndpointStatus, ProcessStatus } from '../backends/types'
import { spawn } from 'child_process'

const execFileAsync = promisify(execFile)

type StatusListener = (state: BackendServeState) => void

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  private processTree: ServeProcessTree | null = null
  private processStatus: ProcessStatus = 'stopped'
  private endpointStatus: EndpointStatus = 'unreachable'
  private pid: number | null = null
  private spawnTime: number | null = null
  private binaryPath: string | null = null
  private error: string | null = null
  private portConflict = false
  private ownedByStudio = false
  private listeners = new Set<StatusListener>()
  private logFile: ReturnType<typeof createWriteStream> | null = null

  constructor() {
    this.setupLogFile()
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
  }): void {
    if (partial.processStatus !== undefined) this.processStatus = partial.processStatus
    if (partial.endpointStatus !== undefined) this.endpointStatus = partial.endpointStatus
    if (partial.pid !== undefined) this.pid = partial.pid
    if (partial.spawnTime !== undefined) this.spawnTime = partial.spawnTime
    if (partial.binaryPath !== undefined) this.binaryPath = partial.binaryPath
    if (partial.error !== undefined) this.error = partial.error
    if (partial.portConflict !== undefined) this.portConflict = partial.portConflict
    if (partial.ownedByStudio !== undefined) this.ownedByStudio = partial.ownedByStudio
    this.emit()
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

  /** Rozpozná již běžící Tabby — nepřivlastní si cizí proces. */
  async detectExternal(): Promise<boolean> {
    tabbyClient.refresh()
    if (!(await tabbyClient.ping())) return false
    this.setPartial({
      processStatus: 'external',
      endpointStatus: 'healthy',
      ownedByStudio: false,
      error: null,
      portConflict: false,
      binaryPath: resolveTabbyPython(loadConfig().tabby!)
    })
    return true
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

  async start(_forceKillConflict = false): Promise<void> {
    if (this.processStatus === 'starting' || this.processStatus === 'running') return

    if (await this.detectExternal()) {
      return
    }

    const pre = preflightTabby()
    if (!pre.ok) {
      this.setPartial({
        processStatus: 'failed',
        error: pre.errors.join('; '),
        binaryPath: pre.pythonPath
      })
      return
    }

    const portBusy = await this.checkPortInUse()
    if (portBusy) {
      // Zkus znovu health — může to být Tabby, které ping krátce selhal
      if (await tabbyClient.ping()) {
        await this.detectExternal()
        return
      }
      this.setPartial({
        processStatus: 'failed',
        error: tMain('errors.portBusy'),
        portConflict: true,
        binaryPath: pre.pythonPath
      })
      return
    }

    this.setPartial({
      processStatus: 'starting',
      endpointStatus: 'unreachable',
      error: null,
      portConflict: false,
      binaryPath: pre.pythonPath,
      pid: null,
      spawnTime: null,
      ownedByStudio: true
    })

    try {
      this.process = spawn(pre.pythonPath, [pre.mainPy], {
        cwd: pre.installDir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false
      })

      const pid = this.process.pid ?? null
      this.processTree?.dispose()
      this.processTree = pid ? attachServeProcessTree(pid) : null
      this.setPartial({ pid, spawnTime: Date.now() })

      this.process.stdout?.on('data', (chunk: Buffer) => {
        logBuffer.append('stdout', chunk.toString('utf-8'))
      })
      this.process.stderr?.on('data', (chunk: Buffer) => {
        logBuffer.append('stderr', chunk.toString('utf-8'))
      })

      this.process.on('error', (err) => {
        this.setPartial({
          processStatus: 'failed',
          error: err.message,
          pid: null,
          spawnTime: null,
          ownedByStudio: false
        })
        this.disposeProcessTree()
        this.process = null
      })

      this.process.on('exit', (code, signal) => {
        if (this.processStatus !== 'stopping') {
          const msg =
            code !== null && code !== 0
              ? tMain('errors.processExitedCode', { code })
              : signal
                ? tMain('errors.processExitedSignal', { signal })
                : null
          this.setPartial({
            processStatus: msg ? 'failed' : 'stopped',
            endpointStatus: 'unreachable',
            error: msg,
            pid: null,
            spawnTime: null,
            ownedByStudio: false
          })
        } else {
          this.setPartial({
            processStatus: 'stopped',
            endpointStatus: 'unreachable',
            pid: null,
            spawnTime: null,
            error: null,
            ownedByStudio: false
          })
        }
        this.disposeProcessTree()
        this.process = null
      })

      await this.waitForReady(180000)
      tabbyClient.refresh()
      readTabbyAuth()
      this.setPartial({
        processStatus: 'running',
        endpointStatus: 'healthy',
        error: null
      })
    } catch (err) {
      await this.killProcess()
      this.setPartial({
        processStatus: 'failed',
        endpointStatus: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
        pid: null,
        spawnTime: null,
        ownedByStudio: false
      })
    }
  }

  async stop(): Promise<void> {
    if (this.processStatus === 'external') {
      this.setPartial({
        error: 'Externí TabbyAPI nelze zastavit ze Studia (proces nevlastníme).'
      })
      return
    }
    if (!this.process) {
      this.disposeProcessTree()
      this.setPartial({
        processStatus: 'stopped',
        endpointStatus: 'unreachable',
        pid: null,
        spawnTime: null,
        ownedByStudio: false
      })
      return
    }
    this.setPartial({ processStatus: 'stopping' })
    await this.killProcess()
    this.setPartial({
      processStatus: 'stopped',
      endpointStatus: 'unreachable',
      pid: null,
      spawnTime: null,
      error: null,
      ownedByStudio: false
    })
  }

  async restart(forceKillConflict = false): Promise<void> {
    if (this.processStatus === 'external') {
      this.setPartial({
        error: 'Externí TabbyAPI nelze restartovat ze Studia.'
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
    if (this.ownedByStudio) await this.stop()
    this.logFile?.end()
    this.logFile = null
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await tabbyClient.ping()) return
      if (this.processStatus === 'failed') {
        throw new Error(this.error ?? tMain('errors.serverTimeout'))
      }
      await sleep(1000)
    }
    throw new Error(tMain('errors.serverTimeout'))
  }

  private async killProcess(): Promise<void> {
    const proc = this.process
    if (!proc || proc.killed) {
      this.disposeProcessTree()
      this.process = null
      return
    }

    const pid = proc.pid
    if (process.platform === 'win32' && pid) {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true
        })
      } catch {
        proc.kill('SIGTERM')
      }
    } else {
      proc.kill('SIGTERM')
    }

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

    this.disposeProcessTree()
    this.process = null
  }

  private disposeProcessTree(): void {
    this.processTree?.dispose()
    this.processTree = null
  }

  private setupLogFile(): void {
    try {
      const logsDir = join(app.getPath('userData'), 'logs')
      const logPath = join(logsDir, 'tabby-serve.log')
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
      this.logFile = createWriteStream(logPath, { flags: 'a' })
      // Sdílíme stejný buffer jako Ollama — aktivní backend zapisuje sem.
      logBuffer.setFileWriter(this.logFile)
    } catch {
      /* ignore */
    }
  }
}

export const tabbyServeManager = new TabbyServeManager()
