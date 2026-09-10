import {
  type AnyProviderActionRequest,
  isBackendId,
  type BackendId,
} from '../../shared/backend-contract'
import { getProvider } from './registry'
import type { BackendProvider } from './provider'

const ACTIONS: Record<BackendId, ReadonlySet<string>> = {
  ollama: new Set([
    'runtime.detect-binary',
    'runtime.update-installer-status',
    'runtime.open-update-terminal'
  ]),
  tabby: new Set([
    'runtime.preflight',
    'hf.refs',
    'download.remember-form',
    'download.delete-folder',
    'runtime.scrub-logs',
    'runtime.delete-zip-logs'
  ])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): boolean {
  return value == null || typeof value === 'string'
}

function onlyKeys(
  payload: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(payload).every((key) => allowed.includes(key))
}

function hasValidPayload(
  providerId: BackendId,
  action: string,
  payload: Record<string, unknown>
): boolean {
  if (providerId === 'ollama') {
    return (
      (
        action === 'runtime.detect-binary' ||
        action === 'runtime.update-installer-status' ||
        action === 'runtime.open-update-terminal'
      ) &&
      onlyKeys(payload, [])
    )
  }
  switch (action) {
    case 'runtime.preflight':
    case 'runtime.scrub-logs':
      return onlyKeys(payload, [])
    case 'hf.refs':
      return (
        onlyKeys(payload, ['repoId', 'token']) &&
        typeof payload.repoId === 'string' &&
        payload.repoId.trim().length > 0 &&
        optionalString(payload.token)
      )
    case 'download.remember-form':
      return (
        onlyKeys(payload, ['repoId', 'revision', 'folderName']) &&
        typeof payload.repoId === 'string' &&
        typeof payload.revision === 'string' &&
        typeof payload.folderName === 'string'
      )
    case 'download.delete-folder':
      return (
        onlyKeys(payload, ['folderName']) &&
        typeof payload.folderName === 'string' &&
        payload.folderName.trim().length > 0
      )
    case 'runtime.delete-zip-logs':
      return (
        onlyKeys(payload, ['zipPaths']) &&
        Array.isArray(payload.zipPaths) &&
        payload.zipPaths.every((path) => typeof path === 'string')
      )
    default:
      return false
  }
}

export function validateProviderActionRequest(
  value: unknown
): AnyProviderActionRequest {
  if (!isRecord(value) || !isBackendId(value.providerId)) {
    throw new Error('INVALID_PROVIDER_ACTION')
  }
  if (
    typeof value.action !== 'string' ||
    !ACTIONS[value.providerId].has(value.action) ||
    !isRecord(value.payload) ||
    !hasValidPayload(value.providerId, value.action, value.payload)
  ) {
    throw new Error('INVALID_PROVIDER_ACTION')
  }
  return value as AnyProviderActionRequest
}

export async function invokeProviderAction(
  value: unknown,
  resolveProvider: (id: BackendId) => BackendProvider = getProvider
): Promise<unknown> {
  const request = validateProviderActionRequest(value)
  const provider = resolveProvider(request.providerId)
  return provider.invokeAction(
    request.action as never,
    request.payload as never
  )
}
