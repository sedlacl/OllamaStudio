import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { OllamaEnvConfig } from './config'
import { getMainLocale, tMain } from '../i18n'
import { localeTag } from '../i18n/types'
import { atomicWriteJson } from '../storage/atomic-json'
import type { BackendId, PresetScope, ProviderPreset } from '../../shared/backend-contract'

export type PresetKind = 'load' | 'serve' | 'tabby-load'

/** Volba `use_mmap`; `auto` = neposílat a nechat rozhodnout Ollamu. */
export type MmapPreference = 'auto' | 'on' | 'off'

/** Formulář dialogu Načíst model — stringová pole jako ve UI. */
export interface LoadPresetData {
  keepInMemory: boolean
  ttl: string
  numCtx: string
  numBatch: string
  numGpu: string
  numThread: string
  /** Presety z verzí do 1.3.2 mají boolean. */
  useMmap: MmapPreference | boolean
  useMlock: boolean
  ropeBase: string
  ropeScale: string
}

export interface ServePresetData {
  ollamaEnv: OllamaEnvConfig
  autoStartServe: boolean
}

export interface TabbyLoadPresetData {
  maxSeqLen: string
  cacheSize: string
  cacheMode: string
  tensorParallel: boolean
  gpuSplitAuto: boolean
  gpuSplit: string
  chunkSize: string
  outputChunking: boolean
  vision: boolean
  agentEnabled: boolean
  mtpEnabled: boolean
  draftNumTokens: string
}

export type PresetDataMap = {
  load: LoadPresetData
  serve: ServePresetData
  'tabby-load': TabbyLoadPresetData
}

export interface Preset<K extends PresetKind = PresetKind> {
  id: string
  name: string
  providerId: BackendId
  scope: PresetScope
  schemaVersion: number
  /** @deprecated Kompatibilní identifikátor pro současný renderer. */
  kind: K
  updatedAt: number
  data: PresetDataMap[K]
}

interface PresetStoreFile {
  version: 2
  presets: ProviderPreset[]
}

function presetsDir(): string {
  return join(app.getPath('userData'), 'presets')
}

const KIND_TARGET: Record<PresetKind, { providerId: BackendId; scope: PresetScope }> = {
  load: { providerId: 'ollama', scope: 'model-profile' },
  serve: { providerId: 'ollama', scope: 'settings' },
  'tabby-load': { providerId: 'tabby', scope: 'model-profile' }
}

function storePath(kind: PresetKind): string {
  const target = KIND_TARGET[kind]
  return join(presetsDir(), `${target.providerId}.${target.scope}.json`)
}

function legacyStorePath(kind: PresetKind): string {
  return join(presetsDir(), `${kind}.json`)
}

function emptyStore(): PresetStoreFile {
  return { version: 2, presets: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function validatePresetData<K extends PresetKind>(kind: K, value: unknown): PresetDataMap[K] {
  if (!isRecord(value)) throw new Error(tMain('errors.missingData'))
  if (kind === 'load') {
    const data = value as Partial<LoadPresetData>
    if (typeof data.keepInMemory !== 'boolean' || typeof data.ttl !== 'string') {
      throw new Error(tMain('errors.missingData'))
    }
    return {
      keepInMemory: data.keepInMemory,
      ttl: data.ttl,
      numCtx: typeof data.numCtx === 'string' ? data.numCtx : '',
      numBatch: typeof data.numBatch === 'string' ? data.numBatch : '',
      numGpu: typeof data.numGpu === 'string' ? data.numGpu : '',
      numThread: typeof data.numThread === 'string' ? data.numThread : '',
      useMmap: data.useMmap === true ? 'on' : data.useMmap === false ? 'off' : data.useMmap ?? 'auto',
      useMlock: data.useMlock === true,
      ropeBase: typeof data.ropeBase === 'string' ? data.ropeBase : '',
      ropeScale: typeof data.ropeScale === 'string' ? data.ropeScale : ''
    } as PresetDataMap[K]
  }
  if (kind === 'serve') {
    const data = value as Partial<ServePresetData>
    if (!isRecord(data.ollamaEnv)) throw new Error(tMain('errors.missingData'))
    return {
      ollamaEnv: data.ollamaEnv as unknown as OllamaEnvConfig,
      autoStartServe: data.autoStartServe !== false
    } as PresetDataMap[K]
  }
  const data = value as Partial<TabbyLoadPresetData>
  if (typeof data.maxSeqLen !== 'string') throw new Error(tMain('errors.missingData'))
  return {
    maxSeqLen: data.maxSeqLen,
    cacheSize: typeof data.cacheSize === 'string' ? data.cacheSize : '',
    cacheMode: typeof data.cacheMode === 'string' ? data.cacheMode : '',
    tensorParallel: data.tensorParallel === true,
    gpuSplitAuto: data.gpuSplitAuto !== false,
    gpuSplit: typeof data.gpuSplit === 'string' ? data.gpuSplit : '',
    chunkSize: typeof data.chunkSize === 'string' ? data.chunkSize : '',
    outputChunking: data.outputChunking === true,
    vision: data.vision === true,
    agentEnabled: data.agentEnabled === true,
    mtpEnabled: data.mtpEnabled === true,
    draftNumTokens: typeof data.draftNumTokens === 'string' ? data.draftNumTokens : ''
  } as PresetDataMap[K]
}

function fromStored<K extends PresetKind>(kind: K, preset: ProviderPreset): Preset<K> {
  return {
    id: preset.id,
    name: preset.name,
    ...KIND_TARGET[kind],
    schemaVersion: preset.schemaVersion,
    kind,
    updatedAt: preset.updatedAt,
    data: validatePresetData(kind, preset.data)
  }
}

function readStore<K extends PresetKind>(kind: K): PresetStoreFile {
  const path = storePath(kind)
  if (!existsSync(path)) return migrateLegacyStore(kind)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PresetStoreFile>
    const presets = Array.isArray(raw.presets) ? raw.presets : []
    const target = KIND_TARGET[kind]
    return {
      version: 2,
      presets: presets.filter(
        (p): p is ProviderPreset =>
          !!p &&
          isRecord(p) &&
          typeof p.id === 'string' &&
          typeof p.name === 'string' &&
          p.providerId === target.providerId &&
          p.scope === target.scope &&
          typeof p.schemaVersion === 'number' &&
          p.data != null
      )
    }
  } catch {
    return emptyStore()
  }
}

function migrateLegacyStore<K extends PresetKind>(kind: K): PresetStoreFile {
  const legacyPath = legacyStorePath(kind)
  if (!existsSync(legacyPath)) return emptyStore()
  try {
    const raw = JSON.parse(readFileSync(legacyPath, 'utf-8')) as { presets?: unknown[] }
    const target = KIND_TARGET[kind]
    const presets: ProviderPreset[] = []
    for (const value of Array.isArray(raw.presets) ? raw.presets : []) {
      if (!isRecord(value) || value.kind !== kind || typeof value.id !== 'string' || typeof value.name !== 'string') continue
      try {
        presets.push({
          id: value.id,
          name: value.name,
          ...target,
          schemaVersion: 1,
          updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
          data: validatePresetData(kind, value.data)
        })
      } catch {
        // Jediný poškozený preset nezablokuje migraci ostatních.
      }
    }
    const store = { version: 2 as const, presets }
    writeStore(kind, store)
    return store
  } catch {
    return emptyStore()
  }
}

function writeStore(kind: PresetKind, store: PresetStoreFile): void {
  atomicWriteJson(storePath(kind), store)
}

export function listPresets<K extends PresetKind>(kind: K): Array<Preset<K>> {
  return readStore(kind)
    .presets.map((preset) => fromStored(kind, preset))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, localeTag(getMainLocale())) || b.updatedAt - a.updatedAt
    )
}

export function getPreset<K extends PresetKind>(kind: K, id: string): Preset<K> | null {
  const preset = readStore(kind).presets.find((p) => p.id === id)
  return preset ? fromStored(kind, preset) : null
}

export function savePreset<K extends PresetKind>(
  kind: K,
  name: string,
  data: PresetDataMap[K],
  id?: string
): Preset<K> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error(tMain('errors.presetNameEmpty'))
  const validated = validatePresetData(kind, data)

  const store = readStore(kind)
  const now = Date.now()
  const existingIdx = id
    ? store.presets.findIndex((p) => p.id === id)
    : store.presets.findIndex((p) => p.name.toLowerCase() === trimmed.toLowerCase())

  let stored: ProviderPreset
  if (existingIdx >= 0) {
    const prev = store.presets[existingIdx]
    stored = { ...prev, name: trimmed, updatedAt: now, data: validated }
    store.presets[existingIdx] = stored
  } else {
    stored = {
      id: randomUUID(),
      name: trimmed,
      ...KIND_TARGET[kind],
      schemaVersion: 1,
      updatedAt: now,
      data: validated
    }
    store.presets.push(stored)
  }

  writeStore(kind, store)
  return fromStored(kind, stored)
}

export function deletePreset(kind: PresetKind, id: string): boolean {
  const store = readStore(kind)
  const next = store.presets.filter((p) => p.id !== id)
  if (next.length === store.presets.length) return false
  writeStore(kind, { version: 2, presets: next })
  return true
}

/** Import z JSON — přijímá celý Preset, nebo jen { name?, data }. */
export function importPresetJson<K extends PresetKind>(
  kind: K,
  raw: string
): Preset<K> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(tMain('errors.invalidJson'))
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(tMain('errors.jsonMustBeObject'))
  }

  const obj = parsed as Record<string, unknown>
  const target = KIND_TARGET[kind]
  if (obj.kind != null && obj.kind !== kind) {
    throw new Error(
      tMain('errors.presetKindMismatch', { kind: String(obj.kind), expected: kind })
    )
  }
  if (obj.providerId != null && obj.providerId !== target.providerId) {
    throw new Error(tMain('errors.presetKindMismatch', {
      kind: String(obj.providerId),
      expected: target.providerId
    }))
  }
  if (obj.scope != null && obj.scope !== target.scope) {
    throw new Error(tMain('errors.presetKindMismatch', {
      kind: String(obj.scope),
      expected: target.scope
    }))
  }
  if (obj.schemaVersion != null && obj.schemaVersion !== 1) {
    throw new Error(tMain('errors.missingData'))
  }

  const data = validatePresetData(kind, obj.data ?? obj)

  const name =
    typeof obj.name === 'string' && obj.name.trim()
      ? obj.name.trim()
      : tMain('errors.importName', {
          when: new Date().toLocaleString(localeTag(getMainLocale()))
        })

  return savePreset(kind, name, data)
}

export function exportPresetJson(preset: Preset): string {
  return JSON.stringify(
    {
      providerId: preset.providerId,
      scope: preset.scope,
      schemaVersion: preset.schemaVersion,
      name: preset.name,
      updatedAt: preset.updatedAt,
      data: preset.data
    },
    null,
    2
  )
}
