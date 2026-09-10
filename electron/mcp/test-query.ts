import { isBackendId, type ModelRef } from '../../shared/backend-contract'
import { getProvider } from '../backends/registry'
import type { BackendProvider } from '../backends/provider'
import { sanitizeSecrets } from '../security/sanitize-state'

export const TEST_QUERY_DEFAULT_MAX_TOKENS = 64
export const TEST_QUERY_DEFAULT_TIMEOUT_MS = 30_000
export const TEST_QUERY_MIN_TIMEOUT_MS = 1_000
export const TEST_QUERY_MAX_TIMEOUT_MS = 120_000
export const TEST_QUERY_MIN_MAX_TOKENS = 1
export const TEST_QUERY_MAX_MAX_TOKENS = 512
export const TEST_QUERY_MAX_PROMPT_CHARS = 8_000
export const TEST_QUERY_MAX_OUTPUT_CHARS = 4_096

export interface TestQueryRequest {
  ref: ModelRef
  prompt: string
  maxTokens: number
  timeoutMs: number
}

export interface TestQueryProviderResult {
  text: string
  thinking: string
  ttftMs: number
  totalMs: number
  generatedTokens: number | null
  tokensPerSecond: number | null
  promptTokens: number | null
}

export interface TestQueryResult {
  providerId: ModelRef['providerId']
  modelId: string
  text: string
  truncated: boolean
  ttftMs: number | null
  tokensPerSecond: number | null
  generatedTokens: number | null
  promptTokens: number | null
  totalMs: number
}

export type TestQueryErrorCode =
  | 'INVALID_MODEL_REFERENCE'
  | 'INVALID_TEST_QUERY'
  | 'TEST_QUERY_TIMEOUT'

export class TestQueryError extends Error {
  constructor(
    public readonly code: TestQueryErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'TestQueryError'
  }
}

export interface TestQueryDependencies {
  getProvider: (id: ModelRef['providerId']) => Pick<BackendProvider, 'runTestQuery'>
}

const defaults: TestQueryDependencies = {
  getProvider
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)
}

export function parseTestQueryRequest(value: unknown): TestQueryRequest {
  const raw = (value ?? {}) as Record<string, unknown>
  const refSource =
    raw.ref && typeof raw.ref === 'object'
      ? (raw.ref as Record<string, unknown>)
      : raw
  const providerId = refSource.providerId ?? raw.providerId
  const modelIdRaw = refSource.modelId ?? raw.modelId
  if (
    !isBackendId(providerId) ||
    typeof modelIdRaw !== 'string' ||
    !modelIdRaw.trim() ||
    modelIdRaw.trim().length > 512 ||
    modelIdRaw.includes('\0')
  ) {
    throw new TestQueryError('INVALID_MODEL_REFERENCE', 'Invalid model reference')
  }

  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (!prompt) {
    throw new TestQueryError('INVALID_TEST_QUERY', 'prompt is required')
  }
  if (prompt.length > TEST_QUERY_MAX_PROMPT_CHARS) {
    throw new TestQueryError(
      'INVALID_TEST_QUERY',
      `prompt exceeds ${TEST_QUERY_MAX_PROMPT_CHARS} characters`
    )
  }

  const maxTokens =
    raw.maxTokens === undefined
      ? TEST_QUERY_DEFAULT_MAX_TOKENS
      : isFiniteInt(raw.maxTokens)
        ? raw.maxTokens
        : null
  if (
    maxTokens === null ||
    maxTokens < TEST_QUERY_MIN_MAX_TOKENS ||
    maxTokens > TEST_QUERY_MAX_MAX_TOKENS
  ) {
    throw new TestQueryError(
      'INVALID_TEST_QUERY',
      `maxTokens must be an integer from ${TEST_QUERY_MIN_MAX_TOKENS} to ${TEST_QUERY_MAX_MAX_TOKENS}`
    )
  }

  const timeoutMs =
    raw.timeoutMs === undefined && raw.timeout === undefined
      ? TEST_QUERY_DEFAULT_TIMEOUT_MS
      : isFiniteInt(raw.timeoutMs as number)
        ? (raw.timeoutMs as number)
        : isFiniteInt(raw.timeout)
          ? raw.timeout
          : null
  if (
    timeoutMs === null ||
    timeoutMs < TEST_QUERY_MIN_TIMEOUT_MS ||
    timeoutMs > TEST_QUERY_MAX_TIMEOUT_MS
  ) {
    throw new TestQueryError(
      'INVALID_TEST_QUERY',
      `timeoutMs must be an integer from ${TEST_QUERY_MIN_TIMEOUT_MS} to ${TEST_QUERY_MAX_TIMEOUT_MS}`
    )
  }

  return {
    ref: { providerId, modelId: modelIdRaw.trim() },
    prompt,
    maxTokens,
    timeoutMs
  }
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= TEST_QUERY_MAX_OUTPUT_CHARS) {
    return { text, truncated: false }
  }
  return { text: text.slice(0, TEST_QUERY_MAX_OUTPUT_CHARS), truncated: true }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: string }).name
  return name === 'TimeoutError' || name === 'AbortError'
}

function finiteOrNull(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/**
 * Jednotný test generate/chat pro MCP `run_test_query`.
 * Tool registry má importovat tuto funkci, ne volání Ollama/Tabby HTTP přímo.
 */
export async function runTestQuery(
  input: unknown,
  dependencies: TestQueryDependencies = defaults
): Promise<TestQueryResult> {
  const request = parseTestQueryRequest(input)
  const provider = dependencies.getProvider(request.ref.providerId)

  let raw: TestQueryProviderResult
  try {
    raw = await provider.runTestQuery(request.ref.modelId, {
      prompt: request.prompt,
      maxTokens: request.maxTokens,
      timeoutMs: request.timeoutMs
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw new TestQueryError('TEST_QUERY_TIMEOUT', 'Test query timed out')
    }
    throw error
  }

  const combined = (raw.text || raw.thinking || '').trim()
  const { text, truncated } = truncateText(sanitizeSecrets(combined))

  return {
    providerId: request.ref.providerId,
    modelId: request.ref.modelId,
    text,
    truncated,
    ttftMs: finiteOrNull(raw.ttftMs),
    tokensPerSecond: finiteOrNull(raw.tokensPerSecond),
    generatedTokens: finiteOrNull(raw.generatedTokens),
    promptTokens: finiteOrNull(raw.promptTokens),
    totalMs: finiteOrNull(raw.totalMs) ?? 0
  }
}
