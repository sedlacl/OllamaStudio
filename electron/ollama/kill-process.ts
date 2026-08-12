import { execFile } from 'child_process'
import { promisify } from 'util'
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
 * Ukončí jen Ollama / llama-server procesy.
 * Pokud jde o PID spravovaného `ollama serve`, zavolá stopServe() (čistý shutdown).
 */
export async function killOllamaRelatedProcess(
  pid: number,
  options: {
    servePid: number | null
    stopServe: () => Promise<void>
  }
): Promise<KillProcessResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: 'Neplatné PID' }
  }
  if (pid === process.pid) {
    return { ok: false, error: 'Nelze ukončit vlastní proces aplikace' }
  }

  if (options.servePid != null && pid === options.servePid) {
    try {
      await options.stopServe()
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'Ukončení serve selhalo'
      }
    }
  }

  const name = await getProcessName(pid)
  if (!name) {
    return { ok: false, error: `Proces ${pid} už neběží` }
  }
  if (!isOllamaRelatedName(name)) {
    return {
      ok: false,
      error: `PID ${pid} (${name}) není Ollama / llama runner — ukončení odmítnuto`
    }
  }

  try {
    await forceKillPid(pid)
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : `Ukončení PID ${pid} selhalo`
    }
  }
}
