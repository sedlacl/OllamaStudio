import {
  getActiveBackend,
  loadConfig,
  saveConfig,
  type AppConfig
} from '../ollama/config'
import { ollamaClient } from '../ollama/client'
import { serveManager as ollamaServeManager } from '../ollama/serve-manager'
import { tabbyServeManager, preflightTabby } from './serve-manager'
import { tabbyClient } from './client'
import { clearAllLoadOptions } from '../ollama/load-options-registry'
import { clearAllSpeedTests } from '../ollama/speed-test-registry'
import type { BackendId, BackendServeState } from '../backends/types'
import { capabilitiesFor } from '../backends/types'
import { logBuffer } from '../ollama/log-buffer'

/**
 * Jeden aktivní backend — přepnutí zastaví Studiem vlastněný předchozí proces.
 */
export async function switchActiveBackend(next: BackendId): Promise<BackendServeState> {
  const config = loadConfig()
  const current = getActiveBackend(config)
  if (current === next) {
    return getUnifiedServeState()
  }

  if (current === 'ollama') {
    if (ollamaServeManager.isRunning()) {
      await ollamaServeManager.stop()
    }
  } else {
    const state = tabbyServeManager.getState()
    if (state.ownedByStudio && tabbyServeManager.isRunning()) {
      await tabbyServeManager.stop()
    }
  }

  clearAllLoadOptions()
  clearAllSpeedTests()
  logBuffer.clear()
  logBuffer.setVendor(next === 'tabby' ? 'tabby' : 'ollama')

  config.activeBackend = next
  saveConfig(config)

  if (next === 'tabby') {
    tabbyClient.refresh()
    const auto = Boolean(loadConfig().tabby?.autoStartServe)
    if (auto) await tabbyServeManager.start()
    else await tabbyServeManager.adoptOrDetect()
  } else {
    ollamaClient.refreshBaseUrl()
  }

  return getUnifiedServeState()
}

export function getUnifiedServeState(): BackendServeState {
  const backend = getActiveBackend()
  if (backend === 'tabby') {
    return tabbyServeManager.getState()
  }
  const s = ollamaServeManager.getState()
  return {
    backend: 'ollama',
    processStatus:
      s.status === 'error'
        ? 'failed'
        : (s.status as BackendServeState['processStatus']),
    endpointStatus:
      s.status === 'running' ? 'healthy' : s.status === 'starting' ? 'degraded' : 'unreachable',
    status: s.status,
    pid: s.pid,
    spawnTime: s.spawnTime,
    binaryPath: s.binaryPath,
    error: s.error,
    portConflict: s.portConflict,
    ownedByStudio: true,
    auth: { hasApiKey: true, hasAdminKey: true, disableAuth: true }
  }
}

export async function startActiveBackend(forceKillConflict = false): Promise<BackendServeState> {
  const backend = getActiveBackend()
  if (backend === 'tabby') {
    await tabbyServeManager.start(forceKillConflict)
  } else {
    await ollamaServeManager.start(forceKillConflict)
  }
  return getUnifiedServeState()
}

export async function stopActiveBackend(): Promise<BackendServeState> {
  const backend = getActiveBackend()
  if (backend === 'tabby') {
    await tabbyServeManager.stop()
  } else {
    await ollamaServeManager.stop()
  }
  clearAllLoadOptions()
  clearAllSpeedTests()
  return getUnifiedServeState()
}

export async function restartActiveBackend(
  forceKillConflict = false
): Promise<BackendServeState> {
  const backend = getActiveBackend()
  if (backend === 'tabby') {
    await tabbyServeManager.restart(forceKillConflict)
  } else {
    await ollamaServeManager.restart(forceKillConflict)
  }
  clearAllLoadOptions()
  clearAllSpeedTests()
  return getUnifiedServeState()
}

export async function saveConfigAndRestartActive(
  config: AppConfig
): Promise<BackendServeState> {
  const prev = getActiveBackend(loadConfig())
  const next = config.activeBackend === 'tabby' ? 'tabby' : 'ollama'
  if (prev !== next) {
    saveConfig(config)
    await switchActiveBackend(next)
    const auto =
      next === 'tabby'
        ? Boolean(config.tabby?.autoStartServe)
        : config.autoStartServe
    if (auto) await startActiveBackend()
    return getUnifiedServeState()
  }

  if (next === 'tabby') {
    await tabbyServeManager.saveConfigAndRestart(config)
  } else {
    await ollamaServeManager.saveConfigAndRestart(config)
  }
  return getUnifiedServeState()
}

export function getActiveCapabilities() {
  return capabilitiesFor(getActiveBackend())
}

export function getActivePid(): number | null {
  return getActiveBackend() === 'tabby'
    ? tabbyServeManager.getPid()
    : ollamaServeManager.getPid()
}

export function getActiveSpawnTime(): number | null {
  return getActiveBackend() === 'tabby'
    ? tabbyServeManager.getSpawnTime()
    : ollamaServeManager.getSpawnTime()
}

export async function shutdownAllBackends(): Promise<void> {
  await Promise.all([
    ollamaServeManager.shutdown(),
    tabbyServeManager.shutdown()
  ])
}

export { preflightTabby }
