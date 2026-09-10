import {
  getActiveBackend,
  loadConfig,
  saveConfig,
  type AppConfig
} from '../ollama/config'
import { clearAllLoadOptions } from '../ollama/load-options-registry'
import { clearAllSpeedTests } from '../ollama/speed-test-registry'
import type { BackendId, BackendServeState } from '../backends/types'
import { logBuffer } from '../ollama/log-buffer'
import {
  getActiveProvider,
  getAllProviders,
  getProvider
} from '../backends/registry'
import { preflightTabby } from './serve-manager'

function clearBackendRuntimeState(): void {
  clearAllLoadOptions()
  clearAllSpeedTests()
}

/**
 * Jeden aktivní backend — přepnutí zastaví Studiem vlastněný předchozí proces.
 */
async function switchBackend(
  next: BackendId,
  autoStartTarget: boolean
): Promise<BackendServeState> {
  const config = loadConfig()
  const current = getActiveBackend(config)
  if (current === next) return getUnifiedServeState()

  const currentProvider = getProvider(current)
  if (currentProvider.isRunning() && currentProvider.getServeState().ownedByStudio) {
    await currentProvider.stop()
  }

  clearBackendRuntimeState()
  logBuffer.clear()

  config.activeBackend = next
  saveConfig(config)

  const nextProvider = getProvider(next)
  logBuffer.setVendor(nextProvider.logVendor)
  return nextProvider.activate(autoStartTarget && nextProvider.shouldAutoStart(config))
}

export async function switchActiveBackend(next: BackendId): Promise<BackendServeState> {
  return switchBackend(next, true)
}

/** Model coordinator si runtime spustí až s resolved profilem. */
export async function switchActiveBackendForModel(
  next: BackendId
): Promise<BackendServeState> {
  return switchBackend(next, false)
}

export function getUnifiedServeState(): BackendServeState {
  return getActiveProvider().getServeState()
}

export async function startActiveBackend(
  forceKillConflict = false
): Promise<BackendServeState> {
  return getActiveProvider().start(forceKillConflict)
}

export async function stopActiveBackend(): Promise<BackendServeState> {
  const state = await getActiveProvider().stop()
  clearBackendRuntimeState()
  return state
}

export async function restartActiveBackend(
  forceKillConflict = false
): Promise<BackendServeState> {
  const state = await getActiveProvider().restart(forceKillConflict)
  clearBackendRuntimeState()
  return state
}

export async function saveConfigAndRestartActive(
  config: AppConfig
): Promise<BackendServeState> {
  const previousId = getActiveBackend(loadConfig())
  const nextId = getActiveBackend(config)

  if (previousId !== nextId) {
    const previous = getProvider(previousId)
    if (previous.isRunning() && previous.getServeState().ownedByStudio) {
      await previous.stop()
    }

    clearBackendRuntimeState()
    logBuffer.clear()
    saveConfig(config)

    const next = getProvider(nextId)
    logBuffer.setVendor(next.logVendor)
    await next.activate(false)
    // Ollama při běžném switchi zachovává historické chování (jen refresh URL),
    // ale Save & Restart má auto-start respektovat pro oba providery.
    if (next.shouldAutoStart(config)) await next.start()
    return next.getServeState()
  }

  return getProvider(nextId).saveConfigAndRestart(config)
}

export function getActiveCapabilities() {
  return getActiveProvider().capabilities
}

export function getActivePid(): number | null {
  return getActiveProvider().getPid()
}

export function getActiveSpawnTime(): number | null {
  return getActiveProvider().getSpawnTime()
}

export async function shutdownAllBackends(): Promise<void> {
  await Promise.all(getAllProviders().map((provider) => provider.shutdown()))
}

export { preflightTabby }
