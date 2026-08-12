import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parseDocument, YAMLMap, YAMLSeq, isMap, isSeq } from 'yaml'
import { loadConfig } from './config'
import { getLoadOptions } from './load-options-registry'

export interface ContinueModelEntry {
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
  models: ContinueModelEntry[]
}

const DEFAULT_ROLES = ['chat', 'edit', 'apply']

function continueDir(): string {
  return join(homedir(), '.continue')
}

function configYamlPath(): string {
  return join(continueDir(), 'config.yaml')
}

/** Ořízne `:latest` a sjednotí case — Continue často ukládá tag bez `:latest`. */
export function normalizeOllamaModelId(name: string): string {
  return name.trim().toLowerCase().replace(/:latest$/, '')
}

function modelsMatch(a: string, b: string): boolean {
  return normalizeOllamaModelId(a) === normalizeOllamaModelId(b)
}

function ensureHttpBase(host: string): string {
  const trimmed = host.trim()
  if (!trimmed) return 'http://127.0.0.1:11434'
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, '')
  return `http://${trimmed.replace(/\/$/, '')}`
}

function displayNameFor(model: string): string {
  const base = model.replace(/:latest$/i, '')
  return `ollama-${base}`
}

function parseContextLength(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw)
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return undefined
}

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

  return { name, model, provider, apiBase, contextLength, roles }
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

function loadDocument(): { path: string; exists: boolean; doc: ReturnType<typeof parseDocument> } {
  const path = configYamlPath()
  if (!existsSync(path)) {
    return { path, exists: false, doc: parseDocument(emptyDocumentYaml()) }
  }
  const raw = readFileSync(path, 'utf-8')
  return { path, exists: true, doc: parseDocument(raw) }
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
  const { path, exists, doc } = loadDocument()
  if (!exists) {
    return { path, exists: false, models: [] }
  }

  const modelsNode = doc.get('models')
  const models: ContinueModelEntry[] = []
  if (isSeq(modelsNode)) {
    for (const item of modelsNode.items) {
      const entry = entryFromNode(item)
      if (entry) models.push(entry)
    }
  }

  return { path, exists: true, models }
}

export function findContinueModel(ollamaModel: string): ContinueModelEntry | null {
  const status = getContinueConfigStatus()
  return (
    status.models.find(
      (m) => m.provider === 'ollama' && modelsMatch(m.model, ollamaModel)
    ) ?? null
  )
}

/** Aktuální settings OllamaStudio → hodnoty pro Continue záznam. */
export function buildContinueSettingsFor(ollamaModel: string): {
  model: string
  name: string
  apiBase: string
  contextLength: number | undefined
} {
  const config = loadConfig()
  const base = ollamaModel.replace(/:latest$/i, '')
  const recorded =
    getLoadOptions(ollamaModel) ??
    getLoadOptions(base) ??
    getLoadOptions(`${base}:latest`)
  const ctxFromLoad = recorded?.options.numCtx
  const ctxFromServer = parseContextLength(config.ollamaEnv.OLLAMA_CONTEXT_LENGTH)
  const existing = findContinueModel(ollamaModel)
  const modelId = ollamaModel.replace(/:latest$/i, '')

  return {
    model: modelId,
    name: existing?.name ?? displayNameFor(modelId),
    apiBase: ensureHttpBase(config.ollamaEnv.OLLAMA_HOST),
    contextLength: ctxFromLoad ?? ctxFromServer ?? existing?.contextLength
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
export function upsertContinueModel(ollamaModel: string): ContinueModelEntry {
  const trimmed = ollamaModel.trim()
  if (!trimmed) throw new Error('Název modelu nesmí být prázdný')

  const settings = buildContinueSettingsFor(trimmed)
  const { path, doc } = loadDocument()
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
  return findContinueModel(trimmed) ?? {
    name: settings.name,
    model: settings.model,
    provider: 'ollama',
    apiBase: settings.apiBase,
    contextLength: settings.contextLength,
    roles: [...DEFAULT_ROLES]
  }
}

/** Odebere ollama záznam odpovídající danému modelu. */
export function removeContinueModel(ollamaModel: string): boolean {
  const trimmed = ollamaModel.trim()
  if (!trimmed) throw new Error('Název modelu nesmí být prázdný')

  const { path, exists, doc } = loadDocument()
  if (!exists) return false

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
