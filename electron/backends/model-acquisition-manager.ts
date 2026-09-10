import {
  isBackendId,
  type AcquisitionState,
  type BackendId,
  type ModelAcquisitionRequest,
  type ModelAcquisitionResult
} from '../../shared/backend-contract'
import { randomUUID } from 'crypto'
import { sanitizeOptionalError, sanitizeUnknownError } from '../security/sanitize-state'
import { registerSecret } from '../security/secret-redactor'
import { switchActiveBackendForModel } from '../tabby/active-backend'
import { getActiveBackend } from '../ollama/config'
import { getAllProviders, getProvider } from './registry'
import type { BackendProvider } from './provider'
import { modelCatalog } from './model-catalog'

const SECRET_KEY =
  /^(token|hfToken|hf_token|apiKey|api_key|adminKey|admin_key|authorization|password|secret|accessToken|access_token)$/i

interface AcquisitionDependencies {
  getActiveProviderId: () => BackendId
  getProvider: (id: BackendId) => BackendProvider
  getProviders: () => BackendProvider[]
  switchProvider: (id: BackendId) => Promise<unknown>
  invalidateCatalog: () => void
  now: () => number
}

const defaults: AcquisitionDependencies = {
  getActiveProviderId: getActiveBackend,
  getProvider,
  getProviders: getAllProviders,
  switchProvider: switchActiveBackendForModel,
  invalidateCatalog: () => modelCatalog.invalidate(),
  now: () => Date.now()
}

function validateRequest(value: unknown): asserts value is ModelAcquisitionRequest {
  const request = value as Partial<ModelAcquisitionRequest> | null
  if (!request || !isBackendId(request.providerId)) {
    throw new Error('INVALID_ACQUISITION_REQUEST')
  }
  const keys = Object.keys(request)
  if (request.providerId === 'ollama') {
    if (
      keys.some((key) => !['providerId', 'source', 'modelId'].includes(key)) ||
      request.source !== 'library' ||
      typeof request.modelId !== 'string' ||
      !request.modelId.trim() ||
      request.modelId.includes('\0')
    ) {
      throw new Error('INVALID_ACQUISITION_REQUEST')
    }
    return
  }
  if (
    keys.some(
      (key) =>
        ![
          'providerId',
          'source',
          'modelId',
          'repoId',
          'revision',
          'folderName',
          'token'
        ].includes(key)
    ) ||
    request.source !== 'hugging-face' ||
    typeof request.repoId !== 'string' ||
    !request.repoId.trim() ||
    request.repoId.includes('\0') ||
    (request.modelId != null && typeof request.modelId !== 'string') ||
    (request.revision != null && typeof request.revision !== 'string') ||
    (request.folderName != null && typeof request.folderName !== 'string') ||
    (request.token != null && typeof request.token !== 'string') ||
    request.modelId?.includes('\0') ||
    request.revision?.includes('\0') ||
    request.folderName?.includes('\0')
  ) {
    throw new Error('INVALID_ACQUISITION_REQUEST')
  }
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 16) return undefined
  if (value == null || typeof value === 'boolean') return value
  if (typeof value === 'string') return sanitizeUnknownError(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue
      result[key] = sanitizeValue(nested, depth + 1)
    }
    return result
  }
  return undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeState(
  input: AcquisitionState,
  now: number
): AcquisitionState {
  const bytesDownloaded = finiteNumber(input.bytesDownloaded)
  const bytesTotal =
    input.bytesTotal === null ? null : finiteNumber(input.bytesTotal)
  const percent =
    input.percent === null
      ? null
      : finiteNumber(input.percent) == null
        ? undefined
        : Math.max(0, Math.min(100, finiteNumber(input.percent)!))
  return {
    providerId: input.providerId,
    modelId: input.modelId.trim(),
    operationId: input.operationId,
    status: input.status,
    startedAt: finiteNumber(input.startedAt) ?? now,
    updatedAt: finiteNumber(input.updatedAt) ?? now,
    bytesDownloaded:
      bytesDownloaded == null ? undefined : Math.max(0, bytesDownloaded),
    bytesTotal:
      bytesTotal == null ? bytesTotal : Math.max(0, bytesTotal),
    percent,
    bytesPerSec:
      input.bytesPerSec === null
        ? null
        : finiteNumber(input.bytesPerSec),
    etaSeconds:
      input.etaSeconds === null
        ? null
        : finiteNumber(input.etaSeconds),
    error: input.error
      ? sanitizeOptionalError(input.error) ?? undefined
      : undefined,
    details: input.details == null ? undefined : sanitizeValue(input.details)
  }
}

export class ModelAcquisitionManager {
  private readonly states = new Map<string, AcquisitionState>()
  private readonly inFlightProviders = new Set<BackendId>()
  private emit: (state: AcquisitionState) => void = () => {}

  constructor(private readonly dependencies: AcquisitionDependencies = defaults) {}

  async initialize(
    persistenceDir: string,
    emit: (state: AcquisitionState) => void
  ): Promise<void> {
    this.emit = emit
    const restored = await Promise.all(
      this.dependencies.getProviders().map((provider) =>
        provider.initializeAcquisition(persistenceDir, (state) => this.upsert(state))
      )
    )
    for (const states of restored) {
      for (const state of states) this.upsert(state)
    }
  }

  getAll(): AcquisitionState[] {
    return [...this.states.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt
    )
  }

  async start(request: ModelAcquisitionRequest): Promise<ModelAcquisitionResult> {
    validateRequest(request)
    const provider = this.dependencies.getProvider(request.providerId)
    const operationId = `acq-${request.providerId}-${randomUUID()}`
    if (this.inFlightProviders.size > 0) {
      const existing = this.getAll().find(
        (state) => state.status === 'running'
      )
      return {
        ok: false,
        operationId: existing?.operationId ?? operationId,
        alreadyRunning: true,
        error: 'ACQUISITION_ALREADY_RUNNING'
      }
    }

    const modelId = provider.resolveAcquisitionModelId(request)
    if (!modelId) throw new Error('INVALID_ACQUISITION_MODEL_ID')
    const startedAt = this.dependencies.now()
    const base: AcquisitionState = {
      providerId: request.providerId,
      modelId,
      operationId,
      status: 'running',
      startedAt,
      updatedAt: startedAt
    }
    const releaseSecret =
      request.providerId === 'tabby' && request.token?.trim()
        ? registerSecret(request.token)
        : () => {}
    this.inFlightProviders.add(request.providerId)
    this.upsert(base)

    try {
      if (provider.getServeState().status !== 'running') {
        if (this.dependencies.getActiveProviderId() !== request.providerId) {
          await this.dependencies.switchProvider(request.providerId)
        }
        const state = await provider.start()
        if (state.status !== 'running') throw new Error('PROVIDER_START_FAILED')
      }

      const result = await provider.acquireModel(
        request,
        operationId,
        (partial) => {
          const current = this.states.get(operationId) ?? base
          this.upsert({
            ...current,
            ...partial,
            providerId: request.providerId,
            modelId,
            operationId,
            startedAt,
            updatedAt: this.dependencies.now()
          })
        }
      )
      const current = this.states.get(operationId) ?? base
      const providerStatus =
        result.details &&
        typeof result.details === 'object' &&
        'status' in result.details
          ? (result.details as { status?: AcquisitionState['status'] }).status
          : undefined
      const status: AcquisitionState['status'] = result.ok
        ? 'success'
        : providerStatus === 'conflict' || providerStatus === 'interrupted'
          ? providerStatus
          : 'error'
      this.upsert({
        ...current,
        status,
        percent: result.ok ? 100 : current.percent,
        error: result.error,
        details: result.details,
        updatedAt: this.dependencies.now()
      })
      if (result.ok) this.dependencies.invalidateCatalog()
      return {
        ...result,
        operationId,
        error: result.error
          ? sanitizeOptionalError(result.error) ?? undefined
          : undefined,
        details: sanitizeValue(result.details)
      }
    } catch (error) {
      const message = sanitizeUnknownError(error)
      const current = this.states.get(operationId) ?? base
      this.upsert({
        ...current,
        status: 'error',
        error: message,
        updatedAt: this.dependencies.now()
      })
      return { ok: false, operationId, error: message }
    } finally {
      this.inFlightProviders.delete(request.providerId)
      releaseSecret()
    }
  }

  async dismiss(operationId: string): Promise<void> {
    if (typeof operationId !== 'string' || !operationId) {
      throw new Error('INVALID_ACQUISITION_OPERATION')
    }
    const state = this.states.get(operationId)
    if (!state || state.status === 'running') return
    await this.dependencies.getProvider(state.providerId).dismissAcquisition(operationId)
    this.states.delete(operationId)
  }

  private upsert(input: AcquisitionState): void {
    const state = normalizeState(input, this.dependencies.now())
    this.states.set(state.operationId, state)
    this.emit(state)
  }
}

export const modelAcquisitionManager = new ModelAcquisitionManager()
