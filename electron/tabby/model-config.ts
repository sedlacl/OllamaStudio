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

function modelConfigPath(modelDir: string, modelName: string): string {
  return join(modelDir, modelName, 'tabby_config.yml')
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

export function ensureModelDir(tabby?: TabbyConfig): string {
  const cfg = tabby ?? loadConfig().tabby!
  const dir = resolveTabbyModelDir(cfg)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
