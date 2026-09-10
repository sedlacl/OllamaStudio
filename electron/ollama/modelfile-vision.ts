import { existsSync, statSync } from 'fs'
import { ggufIsMmproj } from './gguf-metadata'

const FROM_LINE = /^\s*FROM\s+(.+?)\s*$/i

export type FromKind = 'mmproj' | 'weights' | 'unknown'

export function suggestTextOnlyCloneName(modelId: string): string {
  const trimmed = modelId.trim()
  const slash = trimmed.lastIndexOf('/')
  const leaf = (slash >= 0 ? trimmed.slice(slash + 1) : trimmed) || 'model'
  const colon = leaf.indexOf(':')
  const name = colon >= 0 ? leaf.slice(0, colon) : leaf
  const tag = colon >= 0 ? leaf.slice(colon + 1) : 'latest'
  const safeName = sanitizeOllamaPart(name) || 'model'
  const safeTag = sanitizeOllamaPart(`${tag}-text`) || 'text'
  return `${safeName}:${safeTag}`
}

export function stripVisionFromModelfile(
  modelfile: string,
  classifyFrom: (fromValue: string) => FromKind = classifyFromValue
): { modelfile: string; removed: string[] } {
  const lines = modelfile.replace(/\r\n/g, '\n').split('\n')
  const fromIndexes: { index: number; value: string; kind: FromKind }[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(FROM_LINE)
    if (!match) continue
    const value = unquote(match[1].trim())
    fromIndexes.push({ index: i, value, kind: classifyFrom(value) })
  }
  if (fromIndexes.length === 0) {
    throw new Error('MODELFILE_HAS_NO_FROM')
  }
  inferMmprojBySize(fromIndexes)
  const mmproj = fromIndexes.filter((item) => item.kind === 'mmproj')
  if (mmproj.length === 0) {
    throw new Error('MODEL_HAS_NO_SEPARATE_VISION_PROJECTOR')
  }
  const keptFrom = fromIndexes.filter((item) => item.kind !== 'mmproj')
  if (keptFrom.length === 0) {
    throw new Error('MODELFILE_WOULD_HAVE_NO_WEIGHTS')
  }
  const drop = new Set(mmproj.map((item) => item.index))
  const next = lines.filter((_, index) => !drop.has(index)).join('\n').trimEnd() + '\n'
  return { modelfile: next, removed: mmproj.map((item) => item.value) }
}

export function classifyFromValue(fromValue: string): FromKind {
  if (!looksLikeFilesystemPath(fromValue) || !existsSync(fromValue)) return 'unknown'
  try {
    return ggufIsMmproj(fromValue) ? 'mmproj' : 'weights'
  } catch {
    return 'unknown'
  }
}

function inferMmprojBySize(froms: { value: string; kind: FromKind }[]): void {
  if (froms.some((item) => item.kind === 'mmproj')) return
  const withSize = froms
    .map((item) => {
      if (!looksLikeFilesystemPath(item.value) || !existsSync(item.value)) return null
      try {
        return { item, size: statSync(item.value).size }
      } catch {
        return null
      }
    })
    .filter((row): row is { item: { value: string; kind: FromKind }; size: number } => row != null)
  if (withSize.length < 2) return
  const smallest = withSize.reduce((min, row) => (row.size < min.size ? row : min))
  const largest = withSize.reduce((max, row) => (row.size > max.size ? row : max))
  if (smallest.size < 2 * 1024 * 1024 * 1024 && largest.size > 4 * 1024 * 1024 * 1024) {
    smallest.item.kind = 'mmproj'
  }
}

function looksLikeFilesystemPath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

export function blobPathToDigest(fromValue: string): string | null {
  const base = fromValue.replace(/\\/g, '/').split('/').pop() ?? ''
  const match = /^sha256-([a-fA-F0-9]{64})$/.exec(base)
  return match ? `sha256:${match[1].toLowerCase()}` : null
}

export function extractFromValues(modelfile: string): string[] {
  return modelfile
    .replace(/\r\n/g, '\n')
    .split('\n')
    .flatMap((line) => {
      const match = line.match(FROM_LINE)
      return match ? [unquote(match[1].trim())] : []
    })
}

export function filesFromFromValues(fromValues: string[]): Record<string, string> {
  const files: Record<string, string> = {}
  fromValues.forEach((value, index) => {
    const digest = blobPathToDigest(value)
    if (!digest) {
      throw new Error('CREATE_FROM_NOT_A_LOCAL_BLOB')
    }
    const name =
      fromValues.length === 1
        ? 'model.gguf'
        : `model-${String(index + 1).padStart(5, '0')}-of-${String(fromValues.length).padStart(5, '0')}.gguf`
    files[name] = digest
  })
  return files
}

export function parseParametersBlock(block: string | undefined): Record<string, unknown> | undefined {
  if (!block?.trim()) return undefined
  const parameters: Record<string, unknown> = {}
  for (const line of block.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^(\S+)\s+(.+)$/.exec(trimmed)
    if (!match) continue
    const key = match[1]
    const raw = unquote(match[2].trim())
    const asNumber = Number(raw)
    const value = raw !== '' && Number.isFinite(asNumber) && /^-?\d+(\.\d+)?$/.test(raw) ? asNumber : raw
    const existing = parameters[key]
    if (existing === undefined) {
      parameters[key] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      parameters[key] = [existing, value]
    }
  }
  return Object.keys(parameters).length > 0 ? parameters : undefined
}

export type OllamaCreateRequest = {
  model: string
  files: Record<string, string>
  template?: string
  parameters?: Record<string, unknown>
  stream: boolean
}

export function isJinjaChatTemplate(template: string): boolean {
  return (
    /\{\%\s*(set|macro|if|for|elif|endif|endfor)\b/.test(template) ||
    /\{\{\s*content\b/.test(template) ||
    /\{\{\s*render_content\b/.test(template)
  )
}

export function buildTextOnlyCreateRequest(input: {
  model: string
  strippedModelfile: string
  template?: string
  parameters?: string
}): OllamaCreateRequest {
  const fromValues = extractFromValues(input.strippedModelfile)
  if (fromValues.length === 0) throw new Error('MODELFILE_HAS_NO_FROM')
  const request: OllamaCreateRequest = {
    model: input.model,
    files: filesFromFromValues(fromValues),
    stream: true
  }
  const template = input.template?.trim()
  if (template && !isJinjaChatTemplate(template)) request.template = template
  const parameters = parseParametersBlock(input.parameters)
  if (parameters) request.parameters = parameters
  return request
}

function sanitizeOllamaPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}
