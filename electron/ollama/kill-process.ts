import { execFile } from 'child_process'
import { promisify } from 'util'
import { tMain } from '../i18n'
import { sanitizeKillProcessResult } from '../security/sanitize-state'
import { isOllamaRelatedName } from './metrics'

const execFileAsync = promisify(execFile)

export interface KillProcessResult {
  ok: boolean
  error?: string
}

async function getProcessName(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`
        ],
        { windowsHide: true, timeout: 5000 }
      )
      const name = stdout.trim()
      return name || null
    }

    const { stdout } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(pid)], {
      timeout: 5000
    })
    const name = stdout.trim()
    return name || null
  } catch {
    return null
  }
}

async function forceKillPid(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10000
    })
    return
  }
  process.kill(pid, 'SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  try {
    process.kill(pid, 0)
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * Ukončí jen Ollama / llama-server procesy (nebo explicitně povolené PIDy Tabby stromu).
 * Pokud jde o PID spravovaného serve, zavolá stopServe() (čistý shutdown).
 */
export async function killOllamaRelatedProcess(
  pid: number,
  options: {
    servePid: number | null
    stopServe: () => Promise<void>
    /** Povolí ukončení bez kontroly jména (jen v rámci allowedPids). */
    allowAnyName?: boolean
    allowedPids?: number[]
  }
): Promise<KillProcessResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return sanitizeKillProcessResult({ ok: false, error: tMain('errors.invalidPid') })
  }
  if (pid === process.pid) {
    return sanitizeKillProcessResult({ ok: false, error: tMain('errors.cannotKillSelf') })
  }

  if (options.servePid != null && pid === options.servePid) {
    try {
      await options.stopServe()
      return sanitizeKillProcessResult({ ok: true })
    } catch (e) {
      return sanitizeKillProcessResult({
        ok: false,
        error: e instanceof Error ? e.message : tMain('errors.stopServeFailed')
      })
    }
  }

  if (options.allowAnyName) {
    if (!options.allowedPids?.includes(pid)) {
      return sanitizeKillProcessResult({
        ok: false,
        error: tMain('errors.notOllamaProcess', { pid, name: 'unknown' })
      })
    }
    try {
      await forceKillPid(pid)
      return sanitizeKillProcessResult({ ok: true })
    } catch (e) {
      return sanitizeKillProcessResult({
        ok: false,
        error: e instanceof Error ? e.message : tMain('errors.killPidFailed', { pid })
      })
    }
  }

  const name = await getProcessName(pid)
  if (!name) {
    return sanitizeKillProcessResult({ ok: false, error: tMain('errors.processGone', { pid }) })
  }
  if (!isOllamaRelatedName(name)) {
    return sanitizeKillProcessResult({
      ok: false,
      error: tMain('errors.notOllamaProcess', { pid, name })
    })
  }

  try {
    await forceKillPid(pid)
    return sanitizeKillProcessResult({ ok: true })
  } catch (e) {
    return sanitizeKillProcessResult({
      ok: false,
      error: e instanceof Error ? e.message : tMain('errors.killPidFailed', { pid })
    })
  }
}
