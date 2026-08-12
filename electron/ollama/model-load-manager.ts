import type { BrowserWindow } from 'electron'
import type { OllamaClient, ModelLoadOptions } from './client'
import { recordLoadOptions } from './load-options-registry'
import { tMain } from '../i18n'

export type ModelLoadStatus = 'loading' | 'success' | 'error'

export interface ModelLoadState {
  name: string
  status: ModelLoadStatus
  error?: string
  startedAt: number
}

let getWindow: () => BrowserWindow | null = () => null
const activeLoads = new Map<string, ModelLoadState>()

export function initModelLoadManager(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
}

function emit(state: ModelLoadState): void {
  getWindow()?.webContents.send('model-load-status', state)
}

export function getActiveModelLoads(): ModelLoadState[] {
  return Array.from(activeLoads.values())
}

export function startModelLoad(
  client: OllamaClient,
  name: string,
  options?: ModelLoadOptions
): { ok: boolean; error?: string } {
  const existing = activeLoads.get(name)
  if (existing?.status === 'loading') {
    return { ok: false, error: tMain('errors.modelAlreadyLoading', { name }) }
  }

  const loadOptions = options ?? { keepAlive: '-1' }
  const state: ModelLoadState = { name, status: 'loading', startedAt: Date.now() }
  activeLoads.set(name, state)
  emit(state)

  void (async () => {
    try {
      await client.load(name, loadOptions)
      recordLoadOptions(name, loadOptions)
      const success: ModelLoadState = { name, status: 'success', startedAt: state.startedAt }
      activeLoads.set(name, success)
      emit(success)
      setTimeout(() => {
        const current = activeLoads.get(name)
        if (current?.status === 'success' && current.startedAt === state.startedAt) {
          activeLoads.delete(name)
        }
      }, 30_000)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const failed: ModelLoadState = { name, status: 'error', error, startedAt: state.startedAt }
      activeLoads.set(name, failed)
      emit(failed)
    }
  })()

  return { ok: true }
}

export function clearModelLoadState(name: string): void {
  activeLoads.delete(name)
}
