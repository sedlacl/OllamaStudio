import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { OllamaEnvConfig } from './config'
import { getMainLocale, tMain } from '../i18n'
import { localeTag } from '../i18n/types'

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
  kind: K
  updatedAt: number
  data: PresetDataMap[K]
}

interface PresetStoreFile<K extends PresetKind> {
  version: 1
  presets: Array<Preset<K>>
}

function presetsDir(): string {
  return join(app.getPath('userData'), 'presets')
}

function storePath(kind: PresetKind): string {
  return join(presetsDir(), `${kind}.json`)
}

function emptyStore<K extends PresetKind>(): PresetStoreFile<K> {
  return { version: 1, presets: [] }
}

function readStore<K extends PresetKind>(kind: K): PresetStoreFile<K> {
  const path = storePath(kind)
  if (!existsSync(path)) return emptyStore()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PresetStoreFile<K>>
    const presets = Array.isArray(raw.presets) ? raw.presets : []
    return {
      version: 1,
      presets: presets.filter(
        (p): p is Preset<K> =>
          !!p &&
          typeof p === 'object' &&
          typeof p.id === 'string' &&
          typeof p.name === 'string' &&
          p.kind === kind &&
          p.data != null
      )
    }
  } catch {
    return emptyStore()
  }
}

function writeStore<K extends PresetKind>(kind: K, store: PresetStoreFile<K>): void {
  const dir = presetsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(storePath(kind), JSON.stringify(store, null, 2), 'utf-8')
}

export function listPresets<K extends PresetKind>(kind: K): Array<Preset<K>> {
  return readStore(kind)
    .presets.slice()
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, localeTag(getMainLocale())) || b.updatedAt - a.updatedAt
    )
}

export function getPreset<K extends PresetKind>(kind: K, id: string): Preset<K> | null {
  return readStore(kind).presets.find((p) => p.id === id) ?? null
}

export function savePreset<K extends PresetKind>(
  kind: K,
  name: string,
  data: PresetDataMap[K],
  id?: string
): Preset<K> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error(tMain('errors.presetNameEmpty'))

  const store = readStore(kind)
  const now = Date.now()
  const existingIdx = id
    ? store.presets.findIndex((p) => p.id === id)
    : store.presets.findIndex((p) => p.name.toLowerCase() === trimmed.toLowerCase())

  let preset: Preset<K>
  if (existingIdx >= 0) {
    const prev = store.presets[existingIdx]
    preset = { ...prev, name: trimmed, updatedAt: now, data }
    store.presets[existingIdx] = preset
  } else {
    preset = {
      id: randomUUID(),
      name: trimmed,
      kind,
      updatedAt: now,
      data
    }
    store.presets.push(preset)
  }

  writeStore(kind, store)
  return preset
}

export function deletePreset(kind: PresetKind, id: string): boolean {
  const store = readStore(kind)
  const next = store.presets.filter((p) => p.id !== id)
  if (next.length === store.presets.length) return false
  writeStore(kind, { version: 1, presets: next })
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
  if (obj.kind != null && obj.kind !== kind) {
    throw new Error(
      tMain('errors.presetKindMismatch', { kind: String(obj.kind), expected: kind })
    )
  }

  const data = (obj.data ?? obj) as PresetDataMap[K]
  if (!data || typeof data !== 'object') {
    throw new Error(tMain('errors.missingData'))
  }

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
      kind: preset.kind,
      name: preset.name,
      updatedAt: preset.updatedAt,
      data: preset.data
    },
    null,
    2
  )
}
