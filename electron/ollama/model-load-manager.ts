import type { BrowserWindow } from 'electron'
import type { OllamaClient, ModelLoadOptions } from './client'
import { recordLoadOptions } from './load-options-registry'
import { logBuffer } from './log-buffer'
import { tMain } from '../i18n'
import { sanitizeUnknownError } from '../security/sanitize-state'
import { modelRefKey, type ModelRef } from '../../shared/backend-contract'

export type ModelLoadStatus = 'loading' | 'success' | 'error'

export interface ModelLoadState {
  ref: ModelRef
  name: string
  status: ModelLoadStatus
  error?: string
  startedAt: number
}

let getWindow: () => BrowserWindow | null = () => null
const activeLoads = new Map<string, ModelLoadState>()
const loadHistoryTasks = new Map<string, number>()

export function initModelLoadManager(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
}

function emit(state: ModelLoadState): void {
  getWindow()?.webContents.send('model-load-status', state)
}

function emitRequestsChanged(): void {
  getWindow()?.webContents.send('dashboard-requests-changed')
}

function finishLoadHistory(key: string, result: 'done' | 'error', error?: string): void {
  const taskId = loadHistoryTasks.get(key)
  if (taskId == null) return
  logBuffer.finishManagedRequest(taskId, result, error)
  loadHistoryTasks.delete(key)
  emitRequestsChanged()
}

export function getActiveModelLoads(): ModelLoadState[] {
  return Array.from(activeLoads.values())
}

function asRef(value: string | ModelRef): ModelRef {
  return typeof value === 'string' ? { providerId: 'ollama', modelId: value } : value
}

function beginLoad(value: string | ModelRef): { ok: false; error: string } | { ok: true; state: ModelLoadState } {
  const ref = asRef(value)
  const name = ref.modelId
  const key = modelRefKey(ref)
  const existing = activeLoads.get(key)
  if (existing?.status === 'loading') {
    return { ok: false, error: tMain('errors.modelAlreadyLoading', { name }) }
  }
  const state: ModelLoadState = { ref, name, status: 'loading', startedAt: Date.now() }
  activeLoads.set(key, state)
  emit(state)
  const historyTaskId = logBuffer.startManagedRequest('load', name)
  loadHistoryTasks.set(key, historyTaskId)
  emitRequestsChanged()
  return { ok: true, state }
}

function finishLoad(
  ref: ModelRef,
  startedAt: number,
  result: 'done' | 'error',
  error?: string,
  onLoaded?: (name: string) => void
): void {
  const name = ref.modelId
  const key = modelRefKey(ref)
  if (result === 'done') {
    const success: ModelLoadState = { ref, name, status: 'success', startedAt }
    activeLoads.set(key, success)
    emit(success)
    finishLoadHistory(key, 'done')
    onLoaded?.(name)
    setTimeout(() => {
      const current = activeLoads.get(key)
      if (current?.status === 'success' && current.startedAt === startedAt) {
        activeLoads.delete(key)
      }
    }, 30_000)
    return
  }
  const failed: ModelLoadState = { ref, name, status: 'error', error, startedAt }
  activeLoads.set(key, failed)
  emit(failed)
  finishLoadHistory(key, 'error', error)
}

/**
 * Fire-and-forget load (Tabby SSE může trvat desítky sekund bez prvního eventu).
 * IPC musí vrátit hned, jinak dialog zmizí a UI nic neukáže.
 */
export function startBackgroundModelLoad(
  value: string | ModelRef,
  work: () => Promise<void>,
  onLoaded?: (name: string) => void
): { ok: boolean; error?: string } {
  const ref = asRef(value)
  const started = beginLoad(ref)
  if (!started.ok) return started

  void (async () => {
    try {
      await work()
      finishLoad(ref, started.state.startedAt, 'done', undefined, onLoaded)
    } catch (err) {
      finishLoad(ref, started.state.startedAt, 'error', sanitizeUnknownError(err))
    }
  })()

  return { ok: true }
}

export function startModelLoad(
  client: OllamaClient,
  value: string | ModelRef,
  options?: ModelLoadOptions,
  onLoaded?: (name: string) => void
): { ok: boolean; error?: string } {
  const ref = asRef(value)
  const name = ref.modelId
  const loadOptions = options ?? { keepAlive: '-1' }
  return startBackgroundModelLoad(
    ref,
    async () => {
      await client.load(name, loadOptions)
      recordLoadOptions(ref, loadOptions)
    },
    onLoaded
  )
}

export function clearModelLoadState(value: string | ModelRef): void {
  activeLoads.delete(modelRefKey(asRef(value)))
}
