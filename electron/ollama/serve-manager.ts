import { execFile, spawn, type ChildProcess } from 'child_process'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import net from 'net'
import { promisify } from 'util'
import { app } from 'electron'
import {
  buildSpawnEnv,
  loadConfig,
  parseHostPort,
  saveConfig,
  type AppConfig
} from './config'
import { logBuffer } from './log-buffer'
import { ollamaClient } from './client'

const execFileAsync = promisify(execFile)

export type ServeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface ServeState {
  status: ServeStatus
  pid: number | null
  spawnTime: number | null
  binaryPath: string | null
  error: string | null
  portConflict: boolean
}

type StatusListener = (state: ServeState) => void

export class ServeManager {
  private process: ChildProcess | null = null
  private state: ServeState = {
    status: 'stopped',
    pid: null,
    spawnTime: null,
    binaryPath: null,
    error: null,
    portConflict: false
  }
  private listeners = new Set<StatusListener>()
  private logFile: ReturnType<typeof createWriteStream> | null = null

  constructor() {
    this.setupLogFile()
  }

  getState(): ServeState {
    return { ...this.state }
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSpawnTime(): number | null {
    return this.state.spawnTime
  }

  getPid(): number | null {
    return this.state.pid
  }

  isRunning(): boolean {
    return this.state.status === 'running' || this.state.status === 'starting'
  }

  async detectBinary(): Promise<string | null> {
    const candidates = defaultOllamaBinaryCandidates()

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate
      }
    }

    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      const { stdout } = await execFileAsync(cmd, ['ollama'], {
        windowsHide: true,
        timeout: 5000
      })
      const found = stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (found) return found
    } catch {
      /* not in PATH */
    }

    return null
  }

  async checkPortInUse(): Promise<boolean> {
    const config = loadConfig()
    const { host, port } = parseHostPort(config.ollamaEnv.OLLAMA_HOST)
    const checkHost = host === '0.0.0.0' ? '127.0.0.1' : host
    return new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(true))
      server.once('listening', () => {
        server.close(() => resolve(false))
      })
      server.listen(port, checkHost)
    })
  }

  async start(forceKillConflict = false): Promise<void> {
    if (this.state.status === 'starting' || this.state.status === 'running') return

    const binary = await this.detectBinary()
    if (!binary) {
      this.setState({
        status: 'error',
        error: 'Ollama CLI nebylo nalezeno. Nainstalujte Ollama a přidejte do PATH.',
        binaryPath: null
      })
      return
    }

    const portBusy = await this.checkPortInUse()
    if (portBusy && !forceKillConflict) {
      this.setState({
        status: 'error',
        error:
          'Port 11434 je obsazený. Ukončete systémovou Ollamu (tray → Quit) nebo potvrďte ukončení konfliktních procesů.',
        portConflict: true,
        binaryPath: binary
      })
      return
    }

    if (portBusy && forceKillConflict) {
      await this.tryKillConflictingProcesses()
    }

    this.setState({
      status: 'starting',
      error: null,
      portConflict: false,
      binaryPath: binary,
      pid: null,
      spawnTime: null
    })

    const config = loadConfig()
    const env = buildSpawnEnv(config)

    try {
      this.process = spawn(binary, ['serve'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })

      const pid = this.process.pid ?? null
      this.setState({ pid, spawnTime: Date.now() })

      this.process.stdout?.on('data', (chunk: Buffer) => {
        logBuffer.append('stdout', chunk.toString('utf-8'))
      })

      this.process.stderr?.on('data', (chunk: Buffer) => {
        logBuffer.append('stderr', chunk.toString('utf-8'))
      })

      this.process.on('error', (err) => {
        this.setState({
          status: 'error',
          error: err.message,
          pid: null,
          spawnTime: null
        })
        this.process = null
      })

      this.process.on('exit', (code, signal) => {
        if (this.state.status !== 'stopping') {
          const msg =
            code !== null && code !== 0
              ? `Proces skončil s kódem ${code}`
              : signal
                ? `Proces ukončen signálem ${signal}`
                : null
          this.setState({
            status: msg ? 'error' : 'stopped',
            error: msg,
            pid: null,
            spawnTime: null
          })
        } else {
          this.setState({ status: 'stopped', pid: null, spawnTime: null, error: null })
        }
        this.process = null
      })

      await this.waitForReady(30000)
      ollamaClient.refreshBaseUrl()
      this.setState({ status: 'running', error: null })
    } catch (err) {
      await this.killProcess()
      this.setState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        pid: null,
        spawnTime: null
      })
    }
  }

  async stop(): Promise<void> {
    if (!this.process) {
      this.setState({ status: 'stopped', pid: null, spawnTime: null })
      return
    }
    this.setState({ status: 'stopping' })
    await this.killProcess()
    this.setState({ status: 'stopped', pid: null, spawnTime: null, error: null })
  }

  async restart(forceKillConflict = false): Promise<void> {
    await this.stop()
    await this.start(forceKillConflict)
  }

  async saveConfigAndRestart(config: AppConfig): Promise<void> {
    saveConfig(config)
    ollamaClient.refreshBaseUrl()
    if (this.isRunning() || this.process) {
      await this.restart()
    }
  }

  async shutdown(): Promise<void> {
    await this.stop()
    this.logFile?.end()
    this.logFile = null
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await ollamaClient.ping()) return
      await sleep(500)
    }
    throw new Error('Server neodpovídá v časovém limitu')
  }

  private async killProcess(): Promise<void> {
    const proc = this.process
    if (!proc || proc.killed) {
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
    } else if (pid) {
      await killUnixProcessTree(pid)
    } else {
      proc.kill('SIGTERM')
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!proc.killed) {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
        resolve()
      }, 5000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    this.process = null
  }

  private async tryKillConflictingProcesses(): Promise<void> {
    try {
      if (process.platform === 'win32') {
        await execFileAsync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            "Get-Process -Name ollama -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike '*OllamaStudio*' } | Stop-Process -Force"
          ],
          { windowsHide: true, timeout: 10000 }
        )
      } else {
        // Ukončí cizí ollama serve/runner; vlastní Electron proces necháme.
        await execFileAsync(
          'pkill',
          ['-x', 'ollama'],
          { timeout: 5000 }
        ).catch(() => undefined)
        await execFileAsync(
          'pkill',
          ['-f', 'ollama serve'],
          { timeout: 5000 }
        ).catch(() => undefined)
      }
      await sleep(1000)
    } catch {
      /* best effort */
    }
  }

  private setupLogFile(): void {
    try {
      const logsDir = join(app.getPath('userData'), 'logs')
      const logPath = join(logsDir, 'ollama-serve.log')
      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true })
      }
      this.logFile = createWriteStream(logPath, { flags: 'a' })
      logBuffer.setFileWriter(this.logFile)
    } catch {
      logBuffer.setFileWriter(null)
    }
  }

  private setState(partial: Partial<ServeState>): void {
    this.state = { ...this.state, ...partial }
    for (const listener of this.listeners) {
      listener(this.getState())
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Typické instalace Ollama CLI na Windows / Linux / macOS (bez PATH lookup). */
function defaultOllamaBinaryCandidates(): string[] {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    return localAppData
      ? [join(localAppData, 'Programs', 'Ollama', 'ollama.exe')]
      : []
  }

  const candidates = ['/usr/local/bin/ollama', '/usr/bin/ollama']
  const home = process.env.HOME
  if (home) candidates.push(join(home, '.local/bin/ollama'))
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Ollama.app/Contents/Resources/ollama')
  }
  return candidates
}

/**
 * Ukončí PID a jeho potomky (ollama runner / llama-server), obdobně jako taskkill /T.
 */
async function killUnixProcessTree(pid: number): Promise<void> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=', '--no-headers'], {
      timeout: 5000
    })
    const children = new Map<number, number[]>()
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (!m) continue
      const child = parseInt(m[1], 10)
      const parent = parseInt(m[2], 10)
      if (!Number.isFinite(child) || !Number.isFinite(parent)) continue
      const list = children.get(parent) ?? []
      list.push(child)
      children.set(parent, list)
    }

    const toKill: number[] = []
    const stack = [pid]
    const seen = new Set<number>()
    while (stack.length > 0) {
      const current = stack.pop()!
      if (seen.has(current)) continue
      seen.add(current)
      toKill.push(current)
      for (const child of children.get(current) ?? []) stack.push(child)
    }

    // Nejdřív potomci, pak root
    for (const target of toKill.reverse()) {
      try {
        process.kill(target, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

export const serveManager = new ServeManager()
