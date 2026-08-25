import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tMain } from '../i18n'
import { loadConfig } from './config'
import { getLoadOptions } from './load-options-registry'
import {
  apiBasesEquivalent,
  displayNameFor,
  ensureOpenAiV1Base,
  modelsMatch,
  parseContextLength,
  toolMatch,
  type ToolConfigMatch,
  type ToolConfigMismatch
} from './tool-config-shared'

export interface OpenCodeModelEntry {
  /** Klíč v `provider.ollama.models` (Ollama tag). */
  model: string
  /** Display name v OpenCode (`name`). */
  name: string
  apiBase?: string
  contextLength?: number
  outputLength?: number
  providerId: string
}

/** Strop `limit.output` v OpenCode — vyšší hodnoty si stejně sráží na 32k. */
export const MAX_OPENCODE_OUTPUT_LIMIT = 32_000

/**
 * OpenCode spouští auto-compaction při `estimated > context - max(output, buffer)`.
 * Output blízký contextu tedy nechá na prompt jen pár set tokenů a session se
 * kompaktuje hned od prvního requestu, protože systémový prompt s tool schématy
 * bývá přes 10k tokenů. Držíme proto output na čtvrtině okna.
 */
const OUTPUT_LIMIT_CONTEXT_DIVISOR = 4

/** Doporučený `limit.output` pro dané okno; bez známého okna zůstává strop. */
export function recommendedOutputLimit(context: number | undefined): number {
  if (context == null) return MAX_OPENCODE_OUTPUT_LIMIT
  const share = Math.floor(context / OUTPUT_LIMIT_CONTEXT_DIVISOR)
  return Math.max(1, Math.min(share, MAX_OPENCODE_OUTPUT_LIMIT))
}

/** Ručně sníženou hodnotu respektuje, příliš velkou (i z dřívějších verzí) srazí. */
function cappedOutputLimit(existing: number | undefined, context: number | undefined): number {
  const recommended = recommendedOutputLimit(context)
  return existing != null ? Math.min(existing, recommended) : recommended
}

export interface OpenCodeConfigStatus {
  path: string
  exists: boolean
  invalid: boolean
  models: OpenCodeModelEntry[]
}

const SCHEMA = 'https://opencode.ai/config.json'
const PROVIDER_NPM = '@ai-sdk/openai-compatible'
const PROVIDER_NAME = 'Ollama (local)'
const PROVIDER_ID = 'ollama'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

/** Odstraní řádkové i blokové komentáře a trailing čárky (OpenCode JSONC). */
export function parseJsonc(raw: string): unknown {
  let out = ''
  let i = 0
  let inStr = false
  let quote = ''
  let escape = false
  let inLine = false
  let inBlock = false

  while (i < raw.length) {
    const c = raw[i]
    const n = raw[i + 1]

    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      i += 1
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (inStr) {
      out += c
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === quote) inStr = false
      i += 1
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      out += c
      i += 1
      continue
    }
    if (c === '/' && n === '/') {
      inLine = true
      i += 2
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      i += 2
      continue
    }
    out += c
    i += 1
  }

  return JSON.parse(stripTrailingCommas(out))
}

function stripTrailingCommas(input: string): string {
  let out = ''
  let i = 0
  let inStr = false
  let quote = ''
  let escape = false
  while (i < input.length) {
    const c = input[i]
    if (inStr) {
      out += c
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === quote) inStr = false
      i += 1
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      out += c
      i += 1
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < input.length && /\s/.test(input[j])) j += 1
      if (input[j] === '}' || input[j] === ']') {
        i += 1
        continue
      }
    }
    out += c
    i += 1
  }
  return out
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    const key = path.replace(/\\/g, '/').toLowerCase()
    if (!path || seen.has(key)) continue
    seen.add(key)
    result.push(path)
  }
  return result
}

/**
 * Cesty k globálnímu OpenCode configu.
 * Oficiální docs: ~/.config/opencode/opencode.json (i na Windows).
 * Na Windows Go binárka často píše i do %APPDATA%\opencode\.
 */
export function opencodeConfigCandidates(): string[] {
  const names = ['opencode.json', 'opencode.jsonc']
  const dirs: string[] = []

  const custom = process.env.OPENCODE_CONFIG?.trim()
  const customDir = process.env.OPENCODE_CONFIG_DIR?.trim()
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  const appData = process.platform === 'win32' ? process.env.APPDATA?.trim() : undefined

  if (customDir) dirs.push(join(customDir))
  if (xdg) dirs.push(join(xdg, 'opencode'))
  if (appData) dirs.push(join(appData, 'opencode'))
  dirs.push(join(homedir(), '.config', 'opencode'))

  const files: string[] = []
  if (custom) files.push(custom)
  for (const dir of dirs) {
    for (const name of names) files.push(join(dir, name))
  }
  return uniquePaths(files)
}

function defaultWritePath(): string {
  return join(homedir(), '.config', 'opencode', 'opencode.json')
}

function resolveConfigPath(): { path: string; exists: boolean } {
  for (const path of opencodeConfigCandidates()) {
    if (existsSync(path)) return { path, exists: true }
  }
  return { path: defaultWritePath(), exists: false }
}

function getBaseUrl(block: Record<string, unknown>): string | undefined {
  const options = asRecord(block.options)
  const settings = asRecord(block.settings)
  const raw = options?.baseURL ?? settings?.baseURL
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

function setBaseUrl(block: Record<string, unknown>, url: string): void {
  const settings = asRecord(block.settings)
  const options = asRecord(block.options)
  if (settings && !options) {
    settings.baseURL = url
    return
  }
  block.options = { ...(options ?? {}), baseURL: url }
}

function getModelContext(modelBlock: Record<string, unknown>): number | undefined {
  const limit = asRecord(modelBlock.limit)
  return parseContextLength(limit?.context ?? modelBlock.contextLength)
}

function getModelOutput(modelBlock: Record<string, unknown>): number | undefined {
  const limit = asRecord(modelBlock.limit)
  return parseContextLength(limit?.output)
}

/**
 * OpenCode JSON schema: pokud existuje `limit`, jsou povinné `context` i `output`.
 * Chybějící `output` doplní, existující srazí pod strop vůči `context`.
 */
function setModelLimit(
  modelBlock: Record<string, unknown>,
  opts: { context?: number; output?: number } = {}
): void {
  const existing = asRecord(modelBlock.limit) ?? {}
  const context = opts.context ?? parseContextLength(existing.context ?? modelBlock.contextLength)
  const output = opts.output ?? cappedOutputLimit(parseContextLength(existing.output), context)
  if (context == null && modelBlock.limit == null) return
  const limit: Record<string, unknown> = { ...existing }
  if (context != null) limit.context = context
  limit.output = output
  modelBlock.limit = limit
}

function repairProviderModelLimits(models: Record<string, unknown>): void {
  for (const value of Object.values(models)) {
    const block = asRecord(value)
    if (!block || !asRecord(block.limit)) continue
    setModelLimit(block)
  }
}

function isOllamaProvider(id: string, block: Record<string, unknown>): boolean {
  if (id.toLowerCase() === PROVIDER_ID) return true
  if (/ollama/i.test(String(block.name ?? ''))) return true
  const base = getBaseUrl(block) ?? ''
  return /:11434\b/.test(base) || /localhost:11434/i.test(base)
}

function providersRoot(doc: Record<string, unknown>): {
  key: 'provider' | 'providers'
  map: Record<string, unknown>
} {
  const provider = asRecord(doc.provider)
  if (provider) return { key: 'provider', map: provider }
  const providers = asRecord(doc.providers)
  if (providers) return { key: 'providers', map: providers }
  const map: Record<string, unknown> = {}
  doc.provider = map
  return { key: 'provider', map }
}

function findOllamaProvider(doc: Record<string, unknown>): {
  key: 'provider' | 'providers'
  id: string
  block: Record<string, unknown>
} | null {
  const roots: Array<{ key: 'provider' | 'providers'; map: Record<string, unknown> }> = []
  const provider = asRecord(doc.provider)
  const providers = asRecord(doc.providers)
  if (provider) roots.push({ key: 'provider', map: provider })
  if (providers) roots.push({ key: 'providers', map: providers })

  for (const root of roots) {
    const preferred = asRecord(root.map[PROVIDER_ID])
    if (preferred) return { key: root.key, id: PROVIDER_ID, block: preferred }
  }
  for (const root of roots) {
    for (const [id, value] of Object.entries(root.map)) {
      const block = asRecord(value)
      if (block && isOllamaProvider(id, block)) {
        return { key: root.key, id, block }
      }
    }
  }
  return null
}

function listModelsFromDoc(doc: Record<string, unknown>): OpenCodeModelEntry[] {
  const found = findOllamaProvider(doc)
  if (!found) return []
  const models = asRecord(found.block.models)
  if (!models) return []
  const apiBase = getBaseUrl(found.block)
  const entries: OpenCodeModelEntry[] = []
  for (const [model, value] of Object.entries(models)) {
    const block = asRecord(value) ?? {}
    const name = typeof block.name === 'string' && block.name.trim() ? block.name : model
    entries.push({
      model,
      name,
      apiBase,
      contextLength: getModelContext(block),
      outputLength: getModelOutput(block),
      providerId: found.id
    })
  }
  return entries
}

function emptyDocument(): Record<string, unknown> {
  return {
    $schema: SCHEMA,
    provider: {
      [PROVIDER_ID]: {
        npm: PROVIDER_NPM,
        name: PROVIDER_NAME,
        options: { baseURL: ensureOpenAiV1Base('') },
        models: {}
      }
    }
  }
}

function loadDocument(): {
  path: string
  exists: boolean
  invalid: boolean
  doc: Record<string, unknown>
} {
  const { path, exists } = resolveConfigPath()
  if (!exists) {
    return { path, exists: false, invalid: false, doc: emptyDocument() }
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = parseJsonc(raw)
    const doc = asRecord(parsed)
    if (!doc) return { path, exists: true, invalid: true, doc: emptyDocument() }
    return { path, exists: true, invalid: false, doc }
  } catch {
    return { path, exists: true, invalid: true, doc: emptyDocument() }
  }
}

function writeDocument(path: string, doc: Record<string, unknown>): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8')
}

export function getOpenCodeConfigStatus(): OpenCodeConfigStatus {
  const { path, exists, invalid, doc } = loadDocument()
  if (!exists) return { path, exists: false, invalid: false, models: [] }
  if (invalid) return { path, exists: true, invalid: true, models: [] }
  return { path, exists: true, invalid: false, models: listModelsFromDoc(doc) }
}

export function findOpenCodeModel(ollamaModel: string): OpenCodeModelEntry | null {
  const status = getOpenCodeConfigStatus()
  return status.models.find((m) => modelsMatch(m.model, ollamaModel)) ?? null
}

export function buildOpenCodeSettingsFor(ollamaModel: string): {
  model: string
  name: string
  apiBase: string
  contextLength: number | undefined
  outputLength: number
} {
  const config = loadConfig()
  const base = ollamaModel.replace(/:latest$/i, '')
  const recorded =
    getLoadOptions(ollamaModel) ??
    getLoadOptions(base) ??
    getLoadOptions(`${base}:latest`)
  const ctxFromLoad = recorded?.options.numCtx
  const ctxFromServer = parseContextLength(config.ollamaEnv.OLLAMA_CONTEXT_LENGTH)
  const existing = findOpenCodeModel(ollamaModel)
  const modelId = ollamaModel.replace(/:latest$/i, '')
  const contextLength = ctxFromLoad ?? ctxFromServer ?? existing?.contextLength

  return {
    model: modelId,
    name: existing?.name ?? displayNameFor(modelId),
    apiBase: ensureOpenAiV1Base(config.ollamaEnv.OLLAMA_HOST),
    contextLength,
    outputLength: cappedOutputLimit(existing?.outputLength, contextLength)
  }
}

export function matchOpenCodeModel(ollamaModel: string): ToolConfigMatch {
  const settings = buildOpenCodeSettingsFor(ollamaModel)
  const status = getOpenCodeConfigStatus()
  const expected = {
    expectedApiBase: settings.apiBase,
    expectedContextLength: settings.contextLength,
    expectedOutputLength: settings.outputLength
  }

  if (!status.exists) {
    return toolMatch({ state: 'no-config', path: status.path, ...expected })
  }
  if (status.invalid) {
    return toolMatch({ state: 'invalid', path: status.path, ...expected })
  }

  const entry = status.models.find((m) => modelsMatch(m.model, ollamaModel))
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
  if (entry.outputLength !== settings.outputLength) {
    mismatches.push('outputLength')
  }

  return toolMatch({
    state: mismatches.length > 0 ? 'stale' : 'current',
    path: status.path,
    displayName: entry.name,
    modelId: entry.model,
    apiBase: entry.apiBase,
    contextLength: entry.contextLength,
    outputLength: entry.outputLength,
    ...expected,
    mismatches
  })
}

function ensureOllamaProvider(doc: Record<string, unknown>, apiBase: string): {
  id: string
  block: Record<string, unknown>
} {
  const existing = findOllamaProvider(doc)
  if (existing) {
    if (!existing.block.npm) existing.block.npm = PROVIDER_NPM
    if (!existing.block.name) existing.block.name = PROVIDER_NAME
    setBaseUrl(existing.block, apiBase)
    if (!asRecord(existing.block.models)) existing.block.models = {}
    return existing
  }

  const root = providersRoot(doc)
  const block: Record<string, unknown> = {
    npm: PROVIDER_NPM,
    name: PROVIDER_NAME,
    options: { baseURL: apiBase },
    models: {}
  }
  root.map[PROVIDER_ID] = block
  return { id: PROVIDER_ID, block }
}

/**
 * Přidá nebo aktualizuje ollama model v globálním opencode.json
 * podle aktuálních settings OllamaStudio (host → baseURL /v1, context + output limit).
 * Sourozencům `limit.output` doplní i srazí pod strop vůči jejich `limit.context`.
 *
 * Formát dle https://opencode.ai/docs/providers/ a schema `limit.context` + `limit.output`.
 */
export function upsertOpenCodeModel(ollamaModel: string): OpenCodeModelEntry {
  const trimmed = ollamaModel.trim()
  if (!trimmed) throw new Error(tMain('errors.modelNameEmpty'))

  const settings = buildOpenCodeSettingsFor(trimmed)
  const { path, exists, invalid, doc } = loadDocument()
  if (exists && invalid) throw new Error(tMain('errors.opencodeInvalidConfig'))

  if (!doc.$schema) doc.$schema = SCHEMA
  const provider = ensureOllamaProvider(doc, settings.apiBase)
  const models = asRecord(provider.block.models) ?? {}
  provider.block.models = models

  let targetKey: string | null = null
  for (const key of Object.keys(models)) {
    if (modelsMatch(key, trimmed)) {
      targetKey = key
      break
    }
  }

  const modelBlock = asRecord(targetKey != null ? models[targetKey] : null) ?? {}
  if (!modelBlock.name) modelBlock.name = settings.name
  setModelLimit(modelBlock, {
    context: settings.contextLength,
    output: settings.outputLength
  })

  const writeKey = settings.model
  if (targetKey && targetKey !== writeKey) delete models[targetKey]
  models[writeKey] = modelBlock
  repairProviderModelLimits(models)

  writeDocument(path, doc)
  return (
    findOpenCodeModel(trimmed) ?? {
      model: writeKey,
      name: String(modelBlock.name ?? writeKey),
      apiBase: settings.apiBase,
      contextLength: settings.contextLength,
      outputLength: settings.outputLength,
      providerId: provider.id
    }
  )
}

export function removeOpenCodeModel(ollamaModel: string): boolean {
  const trimmed = ollamaModel.trim()
  if (!trimmed) throw new Error(tMain('errors.modelNameEmpty'))

  const { path, exists, invalid, doc } = loadDocument()
  if (!exists) return false
  if (invalid) throw new Error(tMain('errors.opencodeInvalidConfig'))

  const found = findOllamaProvider(doc)
  if (!found) return false
  const models = asRecord(found.block.models)
  if (!models) return false

  let removed = false
  for (const key of Object.keys(models)) {
    if (modelsMatch(key, trimmed)) {
      delete models[key]
      removed = true
    }
  }
  if (!removed) return false

  repairProviderModelLimits(models)
  writeDocument(path, doc)
  return true
}
