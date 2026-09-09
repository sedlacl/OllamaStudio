import type { BrowserWindow } from 'electron'
import type { OllamaClient, ModelLoadOptions } from './client'
import { recordLoadOptions } from './load-options-registry'
import { logBuffer } from './log-buffer'
import { tMain } from '../i18n'
import { sanitizeUnknownError } from '../security/sanitize-state'

export type ModelLoadStatus = 'loading' | 'success' | 'error'

export interface ModelLoadState {
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

function finishLoadHistory(name: string, result: 'done' | 'error', error?: string): void {
  const taskId = loadHistoryTasks.get(name)
  if (taskId == null) return
  logBuffer.finishManagedRequest(taskId, result, error)
  loadHistoryTasks.delete(name)
  emitRequestsChanged()
}

export function getActiveModelLoads(): ModelLoadState[] {
  return Array.from(activeLoads.values())
}

function beginLoad(name: string): { ok: false; error: string } | { ok: true; state: ModelLoadState } {
  const existing = activeLoads.get(name)
  if (existing?.status === 'loading') {
    return { ok: false, error: tMain('errors.modelAlreadyLoading', { name }) }
  }
  const state: ModelLoadState = { name, status: 'loading', startedAt: Date.now() }
  activeLoads.set(name, state)
  emit(state)
  const historyTaskId = logBuffer.startManagedRequest('load', name)
  loadHistoryTasks.set(name, historyTaskId)
  emitRequestsChanged()
  return { ok: true, state }
}

function finishLoad(
  name: string,
  startedAt: number,
  result: 'done' | 'error',
  error?: string,
  onLoaded?: (name: string) => void
): void {
  if (result === 'done') {
    const success: ModelLoadState = { name, status: 'success', startedAt }
    activeLoads.set(name, success)
    emit(success)
    finishLoadHistory(name, 'done')
    onLoaded?.(name)
    setTimeout(() => {
      const current = activeLoads.get(name)
      if (current?.status === 'success' && current.startedAt === startedAt) {
        activeLoads.delete(name)
      }
    }, 30_000)
    return
  }
  const failed: ModelLoadState = { name, status: 'error', error, startedAt }
  activeLoads.set(name, failed)
  emit(failed)
  finishLoadHistory(name, 'error', error)
}

/**
 * Fire-and-forget load (Tabby SSE může trvat desítky sekund bez prvního eventu).
 * IPC musí vrátit hned, jinak dialog zmizí a UI nic neukáže.
 */
export function startBackgroundModelLoad(
  name: string,
  work: () => Promise<void>,
  onLoaded?: (name: string) => void
): { ok: boolean; error?: string } {
  const started = beginLoad(name)
  if (!started.ok) return started

  void (async () => {
    try {
      await work()
      finishLoad(name, started.state.startedAt, 'done', undefined, onLoaded)
    } catch (err) {
      finishLoad(name, started.state.startedAt, 'error', sanitizeUnknownError(err))
    }
  })()

  return { ok: true }
}

export function startModelLoad(
  client: OllamaClient,
  name: string,
  options?: ModelLoadOptions,
  onLoaded?: (name: string) => void
): { ok: boolean; error?: string } {
  const loadOptions = options ?? { keepAlive: '-1' }
  return startBackgroundModelLoad(
    name,
    async () => {
      await client.load(name, loadOptions)
      recordLoadOptions(name, loadOptions)
    },
    onLoaded
  )
}

export function clearModelLoadState(name: string): void {
  activeLoads.delete(name)
}
