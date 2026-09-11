import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import {
  loadConfig,
  resolveTabbyModelDir,
  type TabbyConfig
} from '../ollama/config'

/** Minimální úpravy modelového tabby_config.yml přes text (zachová neznámé klíče). */

export interface TabbyModelDraftOptions {
  draftMode?: 'model' | 'disabled' | 'mtp' | 'ngram'
  draftNumTokens?: number
  dynamicDraft?: boolean
}

export interface TabbyModelAgentOptions {
  enabled: boolean
  /** Tabby `tool_format` — u Qwen3.8 / 3.5 `qwen3_5`. */
  toolFormat?: string
}

const QWEN_THINK_START = '"<think>"'
const QWEN_THINK_END = '"</think>"'
const DEFAULT_QWEN_TOOL_FORMAT = 'qwen3_5'

/** Upsert 2-space keys under a top-level YAML map (`model:`). */
export function upsertTopLevelYamlMap(
  raw: string,
  section: string,
  pairs: Record<string, string>,
  removeKeys: string[] = []
): string {
  const text = raw.replace(/\r\n/g, '\n')
  const header = new RegExp(`^${section}:\\s*(?:\\{\\s*\\})?\\s*$`)
  const lines = text.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (header.test(lines[i])) {
      start = i
      break
    }
  }

  const bodyLines = Object.entries(pairs).map(([key, value]) => `  ${key}: ${value}`)

  if (start < 0) {
    const block = [`${section}:`, ...bodyLines].join('\n')
    return text.trim() ? `${text.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`
  }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^[a-zA-Z_][\w]*\s*:/.test(line) && !line.startsWith(' ') && !line.startsWith('\t')) {
      end = i
      break
    }
  }

  const head = lines.slice(0, start + 1)
  const body = lines.slice(start + 1, end)
  const tail = lines.slice(end)
  const remove = new Set(removeKeys)
  const kept = body.filter((line) => {
    const m = line.match(/^\s{2}([A-Za-z_][\w]*)\s*:/)
    if (!m) return true
    if (remove.has(m[1]) || Object.prototype.hasOwnProperty.call(pairs, m[1])) return false
    return true
  })
  const next = [...head, ...bodyLines, ...kept, ...tail]
  return `${next.join('\n').replace(/\s*$/, '')}\n`
}

/** Reasoning + XML tool parser pro OpenAI `reasoning` / `tool_calls` (OpenCode). */
export function applyModelAgentYaml(
  raw: string,
  options: TabbyModelAgentOptions
): string {
  if (options.enabled) {
    return upsertTopLevelYamlMap(raw, 'model', {
      reasoning: 'true',
      reasoning_start_token: QWEN_THINK_START,
      reasoning_end_token: QWEN_THINK_END,
      tool_format: options.toolFormat?.trim() || DEFAULT_QWEN_TOOL_FORMAT
    })
  }
  return upsertTopLevelYamlMap(
    raw,
    'model',
    { reasoning: 'false' },
    ['reasoning_start_token', 'reasoning_end_token', 'tool_format']
  )
}

/**
 * Je v modelovém configu agentní režim doopravdy zapnutý? Samotné
 * `reasoning: true` nestačí — bez `tool_format` Tabby tool cally neparsuje
 * a OpenCode dostane XML místo `tool_calls`.
 */
export function modelAgentYamlEnabled(raw: string): boolean {
  const lines = raw.split('\n')
  const start = lines.findIndex((line) => /^model\s*:/.test(line))
  if (start < 0) return false

  let reasoning = false
  let toolFormat = false
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z_][\w]*\s*:/.test(line)) break
    const pair = line.match(/^\s{2}([A-Za-z_][\w]*)\s*:\s*(.*)$/)
    if (!pair) continue
    if (pair[1] === 'reasoning') reasoning = pair[2].trim() === 'true'
    if (pair[1] === 'tool_format') toolFormat = pair[2].trim().length > 0
  }
  return reasoning && toolFormat
}

function modelConfigPath(modelDir: string, modelName: string): string {
  return join(modelDir, modelName, 'tabby_config.yml')
}

/** Stav agentního režimu z modelového tabby_config.yml (chybějící soubor = vypnuto). */
export function readModelAgentEnabled(modelName: string, tabby?: TabbyConfig): boolean {
  const cfg = tabby ?? loadConfig().tabby!
  const path = modelConfigPath(resolveTabbyModelDir(cfg), modelName)
  if (!existsSync(path)) return false
  try {
    return modelAgentYamlEnabled(readFileSync(path, 'utf-8'))
  } catch {
    return false
  }
}

function backup(path: string): void {
  if (!existsSync(path)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(path, `${path}.backup.${stamp}`)
}

/**
 * Zapíše draft_mode (MTP) a související draft volby do modelového tabby_config.yml.
 * `/v1/model/load` draft_mode přímo nevystavuje — Tabby ho bere z configu / tabby_config.yml.
 */
export function writeModelMtpConfig(
  modelName: string,
  options: TabbyModelDraftOptions,
  tabby?: TabbyConfig
): string {
  const cfg = tabby ?? loadConfig().tabby!
  const modelDir = resolveTabbyModelDir(cfg)
  const path = modelConfigPath(modelDir, modelName)
  const dir = dirname(path)
  if (!existsSync(dir)) {
    throw new Error(`Model directory missing: ${dir}`)
  }

  let raw = existsSync(path) ? readFileSync(path, 'utf-8') : ''
  if (raw.trim()) backup(path)

  const draftMode = options.draftMode ?? 'mtp'
  const draftBlockLines = [`draft_mode: ${draftMode}`]
  if (options.draftNumTokens != null) {
    draftBlockLines.push(`draft_num_tokens: ${options.draftNumTokens}`)
  }
  if (options.dynamicDraft != null) {
    draftBlockLines.push(`dynamic_draft: ${options.dynamicDraft}`)
  }
  const draftBlock = `draft_model:\n${draftBlockLines.map((l) => `  ${l}`).join('\n')}\n`

  if (/^draft_model\s*:/m.test(raw)) {
    raw = raw.replace(
      /^draft_model\s*:[\s\S]*?(?=^[a-zA-Z_][\w]*\s*:|\s*$)/m,
      draftBlock
    )
  } else if (raw.trim()) {
    raw = `${raw.replace(/\s*$/, '')}\n\n${draftBlock}`
  } else {
    raw = `model: {}\n\n${draftBlock}`
  }

  writeFileSync(path, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf-8')
  return path
}

export function writeModelAgentConfig(
  modelName: string,
  options: TabbyModelAgentOptions,
  tabby?: TabbyConfig
): string {
  const cfg = tabby ?? loadConfig().tabby!
  const modelDir = resolveTabbyModelDir(cfg)
  const path = modelConfigPath(modelDir, modelName)
  const dir = dirname(path)
  if (!existsSync(dir)) {
    throw new Error(`Model directory missing: ${dir}`)
  }

  let raw = existsSync(path) ? readFileSync(path, 'utf-8') : ''
  if (raw.trim()) backup(path)
  raw = applyModelAgentYaml(raw, options)
  writeFileSync(path, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf-8')
  return path
}

export function readModelDraftMode(
  modelName: string,
  tabby?: TabbyConfig
): string | null {
  const cfg = tabby ?? loadConfig().tabby!
  const path = modelConfigPath(resolveTabbyModelDir(cfg), modelName)
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf-8')
  const m = raw.match(/^\s*draft_mode\s*:\s*(\S+)/m)
  return m?.[1] ?? null
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

/**
 * `max_position_embeddings` z HF `config.json` modelu — u multimodálních Qwen3
 * leží pod `text_config`. Slouží jako strop pro odvozený kontext, ne jako
 * hodnota k načtení (tu limituje VRAM).
 */
export function readModelMaxContext(
  modelName: string,
  tabby?: TabbyConfig
): number | undefined {
  const cfg = tabby ?? loadConfig().tabby!
  const path = join(resolveTabbyModelDir(cfg), modelName, 'config.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      max_position_embeddings?: unknown
      text_config?: { max_position_embeddings?: unknown }
    }
    return (
      positiveInt(parsed.max_position_embeddings) ??
      positiveInt(parsed.text_config?.max_position_embeddings)
    )
  } catch {
    return undefined
  }
}

export function ensureModelDir(tabby?: TabbyConfig): string {
  const cfg = tabby ?? loadConfig().tabby!
  const dir = resolveTabbyModelDir(cfg)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
