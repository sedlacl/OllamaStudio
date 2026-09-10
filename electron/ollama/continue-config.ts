import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parseDocument, YAMLMap, YAMLSeq, isMap, isSeq } from 'yaml'
import { tMain } from '../i18n'
import { loadConfig } from './config'
import {
  apiBasesEquivalent,
  displayNameFor,
  ensureHttpBase,
  modelsMatch,
  normalizeOllamaModelId,
  parseContextLength,
  toolMatch,
  type ToolConfigMatch,
  type ToolConfigMismatch
} from './tool-config-shared'
import type { ModelProfile, ModelRef } from '../../shared/backend-contract'

export interface ContinueModelEntry {
  ref: ModelRef
  /** Display name v Continue (`name`) */
  name: string
  /** Ollama tag (`model`) */
  model: string
  provider: string
  apiBase?: string
  contextLength?: number
  roles?: string[]
}

export interface ContinueConfigStatus {
  path: string
  exists: boolean
  invalid: boolean
  models: ContinueModelEntry[]
}

const DEFAULT_ROLES = ['chat', 'edit', 'apply']

function continueDir(): string {
  return join(homedir(), '.continue')
}

function configYamlPath(): string {
  return join(continueDir(), 'config.yaml')
}

export { normalizeOllamaModelId }

function readEntryFromMap(map: YAMLMap): ContinueModelEntry | null {
  const provider = String(map.get('provider') ?? '')
  const model = String(map.get('model') ?? '')
  if (!provider || !model) return null

  const name = String(map.get('name') ?? model)
  const apiBase = map.has('apiBase') ? String(map.get('apiBase')) : undefined
  let contextLength = parseContextLength(map.get('contextLength'))
  const dco = map.get('defaultCompletionOptions')
  if (contextLength == null && isMap(dco)) {
    contextLength = parseContextLength(dco.get('contextLength'))
  }

  const rolesNode = map.get('roles')
  const roles =
    isSeq(rolesNode)
      ? rolesNode.items.map((item) => String(item)).filter(Boolean)
      : undefined

  return {
    ref: { providerId: 'ollama', modelId: model },
    name,
    model,
    provider,
    apiBase,
    contextLength,
    roles
  }
}

function emptyDocumentYaml(): string {
  return [
    'name: Local',
    'version: 1.0.0',
    'schema: v1',
    '',
    'models: []',
    ''
  ].join('\n')
}

function loadDocument(): {
  path: string
  exists: boolean
  invalid: boolean
  doc: ReturnType<typeof parseDocument>
} {
  const path = configYamlPath()
  if (!existsSync(path)) {
    return { path, exists: false, invalid: false, doc: parseDocument(emptyDocumentYaml()) }
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    const doc = parseDocument(raw)
    const invalid = doc.errors.length > 0
    return { path, exists: true, invalid, doc }
  } catch {
    return { path, exists: true, invalid: true, doc: parseDocument(emptyDocumentYaml()) }
  }
}

function ensureModelsSeq(doc: ReturnType<typeof parseDocument>): YAMLSeq {
  const models = doc.get('models')
  if (isSeq(models)) return models
  const seq = new YAMLSeq()
  doc.set('models', seq)
  return seq
}

function entryFromNode(node: unknown): ContinueModelEntry | null {
  if (!isMap(node)) return null
  return readEntryFromMap(node)
}

export function getContinueConfigStatus(): ContinueConfigStatus {
  const { path, exists, invalid, doc } = loadDocument()
  if (!exists) {
    return { path, exists: false, invalid: false, models: [] }
  }
  if (invalid) {
    return { path, exists: true, invalid: true, models: [] }
  }

  const modelsNode = doc.get('models')
  const models: ContinueModelEntry[] = []
  if (isSeq(modelsNode)) {
    for (const item of modelsNode.items) {
      const entry = entryFromNode(item)
      if (entry) models.push(entry)
    }
  }

  return { path, exists: true, invalid: false, models }
}

export function matchContinueModel(
  ref: ModelRef,
  profile: ModelProfile<'ollama'>
): ToolConfigMatch {
  if (ref.providerId !== 'ollama') {
    return toolMatch({ state: 'no-config', path: configYamlPath() })
  }
  const settings = buildContinueSettingsFor(ref, profile)
  const status = getContinueConfigStatus()
  const expected = {
    expectedApiBase: settings.apiBase,
    expectedContextLength: settings.contextLength
  }

  if (!status.exists) {
    return toolMatch({ state: 'no-config', path: status.path, ...expected })
  }
  if (status.invalid) {
    return toolMatch({ state: 'invalid', path: status.path, ...expected })
  }

  const entry = status.models.find(
    (m) => m.provider === 'ollama' && modelsMatch(m.model, ref.modelId)
  )
  if (!entry) {
    return toolMatch({ state: 'missing', path: status.path, ...expected })
  }

  const mismatches: ToolConfigMismatch[] = []
  if (settings.apiBase && !apiBasesEquivalent(entry.apiBase, settings.apiBase)) {
    mismatches.push('apiBase')
  }
  if (
    settings.contextLength != null &&
    entry.contextLength !== settings.contextLength
  ) {
    mismatches.push('contextLength')
  }

  return toolMatch({
    state: mismatches.length > 0 ? 'stale' : 'current',
    path: status.path,
    displayName: entry.name,
    modelId: entry.model,
    apiBase: entry.apiBase,
    contextLength: entry.contextLength,
    ...expected,
    mismatches
  })
}

export function findContinueModel(ref: ModelRef): ContinueModelEntry | null {
  if (ref.providerId !== 'ollama') return null
  const status = getContinueConfigStatus()
  return (
    status.models.find(
      (m) => m.provider === 'ollama' && modelsMatch(m.model, ref.modelId)
    ) ?? null
  )
}

/** Aktuální settings OllamaStudio → hodnoty pro Continue záznam. */
export function buildContinueSettingsFor(
  ref: ModelRef,
  profile: ModelProfile<'ollama'>
): {
  model: string
  name: string
  apiBase: string
  contextLength: number | undefined
} {
  if (ref.providerId !== 'ollama') throw new Error('CONTINUE_UNSUPPORTED_PROVIDER')
  const config = loadConfig()
  const existing = findContinueModel(ref)
  const modelId = ref.modelId.replace(/:latest$/i, '')

  return {
    model: modelId,
    name: existing?.name ?? displayNameFor(modelId),
    apiBase: ensureHttpBase(config.ollamaEnv.OLLAMA_HOST),
    contextLength: profile.numCtx ?? existing?.contextLength
  }
}

function writeDocument(path: string, doc: ReturnType<typeof parseDocument>): void {
  const dir = continueDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, String(doc), 'utf-8')
}

/**
 * Přidá nebo aktualizuje ollama model v ~/.continue/config.yaml
 * podle aktuálních settings OllamaStudio (host, context length, load options).
 */
export function upsertContinueModel(
  ref: ModelRef,
  profile: ModelProfile<'ollama'>
): ContinueModelEntry {
  if (ref.providerId !== 'ollama') throw new Error('CONTINUE_UNSUPPORTED_PROVIDER')
  const trimmed = ref.modelId.trim()
  if (!trimmed) throw new Error(tMain('errors.modelNameEmpty'))

  const settings = buildContinueSettingsFor(ref, profile)
  const { path, exists, invalid, doc } = loadDocument()
  if (exists && invalid) throw new Error(tMain('errors.continueInvalidConfig'))
  const seq = ensureModelsSeq(doc)

  let target: YAMLMap | null = null
  for (const item of seq.items) {
    if (!isMap(item)) continue
    const provider = String(item.get('provider') ?? '')
    const model = String(item.get('model') ?? '')
    if (provider === 'ollama' && modelsMatch(model, trimmed)) {
      target = item
      break
    }
  }

  if (!target) {
    target = doc.createNode({
      name: settings.name,
      provider: 'ollama',
      model: settings.model,
      apiBase: settings.apiBase,
      ...(settings.contextLength != null ? { contextLength: settings.contextLength } : {}),
      roles: [...DEFAULT_ROLES]
    }) as YAMLMap
    seq.add(target)
  } else {
    target.set('provider', 'ollama')
    target.set('model', settings.model)
    target.set('apiBase', settings.apiBase)
    if (!target.has('name')) target.set('name', settings.name)
    if (settings.contextLength != null) {
      target.set('contextLength', settings.contextLength)
      const dco = target.get('defaultCompletionOptions')
      if (isMap(dco) && dco.has('contextLength')) {
        dco.set('contextLength', settings.contextLength)
      }
    }
    if (!target.has('roles')) {
      target.set('roles', doc.createNode([...DEFAULT_ROLES]))
    }
  }

  // Zachovej top-level metadata, pokud chybí.
  if (!doc.has('name')) doc.set('name', 'Local')
  if (!doc.has('version')) doc.set('version', '1.0.0')
  if (!doc.has('schema')) doc.set('schema', 'v1')

  writeDocument(path, doc)
  return findContinueModel(ref) ?? {
    ref: { providerId: 'ollama', modelId: settings.model },
    name: settings.name,
    model: settings.model,
    provider: 'ollama',
    apiBase: settings.apiBase,
    contextLength: settings.contextLength,
    roles: [...DEFAULT_ROLES]
  }
}

/** Odebere ollama záznam odpovídající danému modelu. */
export function removeContinueModel(ref: ModelRef): boolean {
  if (ref.providerId !== 'ollama') return false
  const trimmed = ref.modelId.trim()
  if (!trimmed) throw new Error(tMain('errors.modelNameEmpty'))

  const { path, exists, invalid, doc } = loadDocument()
  if (!exists) return false
  if (invalid) throw new Error(tMain('errors.continueInvalidConfig'))

  const models = doc.get('models')
  if (!isSeq(models)) return false

  const before = models.items.length
  models.items = models.items.filter((item) => {
    if (!isMap(item)) return true
    const provider = String(item.get('provider') ?? '')
    const model = String(item.get('model') ?? '')
    if (provider !== 'ollama') return true
    return !modelsMatch(model, trimmed)
  })

  if (models.items.length === before) return false
  writeDocument(path, doc)
  return true
}
