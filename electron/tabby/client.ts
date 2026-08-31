import {
  loadConfig,
  resolveTabbyModelDir,
  tabbyBaseUrl,
  type TabbyConfig
} from '../ollama/config'
import { studioFetch } from '../ollama/fetch-error'
import { sanitizeUnknownError } from '../security/sanitize-state'
import { adminAuthHeaders, apiAuthHeaders } from './auth'
import type { LoadedModelSummary, ModelSummary } from '../backends/types'

export interface TabbyLoadOptions {
  modelName: string
  maxSeqLen?: number
  cacheSize?: number
  cacheMode?: string
  tensorParallel?: boolean
  gpuSplitAuto?: boolean
  gpuSplit?: number[]
  autosplitReserve?: number[]
  ropeScale?: number
  ropeAlpha?: number | 'auto'
  chunkSize?: number
  outputChunking?: boolean
  vision?: boolean
  promptTemplate?: string
  draftModel?: {
    draftModelName?: string
    draftRopeScale?: number
    draftRopeAlpha?: number | 'auto'
    draftGpuSplit?: number[]
  }
}

export interface TabbyDownloadRequest {
  repoId: string
  revision?: string
  folderName?: string
  token?: string
  include?: string[]
  exclude?: string[]
}

export interface TabbyLoadProgress {
  module: number
  modules: number
  modelType: string
  status?: string
}

export interface TabbySpeedTestResult {
  model: string
  prompt: string
  response: string
  thinking: string
  ttftMs: number
  tokensPerSecond: number
  generatedTokens: number
  promptTokensPerSecond: number
  promptTokens: number
  promptEvalMs: number
  totalMs: number
  loadMs: number
  wasLoaded: boolean
  /** Kde vzít jednotlivé metriky — UI může označit odhad. */
  metricSource: {
    ttft: 'client'
    generationTps: 'client' | 'usage'
    promptTps: 'unavailable' | 'estimate'
    tokens: 'usage' | 'tokenizer' | 'estimate'
  }
}

async function httpError(res: Response): Promise<Error> {
  let detail = ''
  try {
    const text = (await res.text()).trim()
    if (text) {
      try {
        const json = JSON.parse(text) as {
          detail?: string
          error?: { message?: string } | string
        }
        if (typeof json.error === 'string') detail = `: ${sanitizeUnknownError(json.error)}`
        else if (json.error && typeof json.error.message === 'string') {
          detail = `: ${sanitizeUnknownError(json.error.message)}`
        } else if (typeof json.detail === 'string') detail = `: ${sanitizeUnknownError(json.detail)}`
        else detail = `: ${sanitizeUnknownError(text)}`
      } catch {
        detail = `: ${sanitizeUnknownError(text)}`
      }
    }
  } catch {
    /* ignore */
  }
  return new Error(`HTTP ${res.status}${detail}`)
}

export class TabbyClient {
  private baseUrl: string
  private tabby: TabbyConfig

  constructor(tabby?: TabbyConfig) {
    const cfg = loadConfig()
    this.tabby = tabby ?? cfg.tabby!
    this.baseUrl = tabbyBaseUrl(this.tabby)
  }

  refresh(): void {
    const cfg = loadConfig()
    this.tabby = cfg.tabby!
    this.baseUrl = tabbyBaseUrl(this.tabby)
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  private adminHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...adminAuthHeaders(this.tabby) }
  }

  private apiHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...apiAuthHeaders(this.tabby) }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await studioFetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Sonda identity listeneru. Tělo odpovědi se neukládá do logu —
   * volající smí použít jen strukturu (status/issues, přítomnost id).
   */
  async probeListener(): Promise<{
    healthReached: boolean
    healthHttpStatus: number | null
    healthJson: unknown | null
    modelReached: boolean
    modelHttpStatus: number | null
    modelJson: unknown | null
  }> {
    const [health, model] = await Promise.all([
      this.probeJsonPath('/health'),
      this.probeJsonPath('/v1/model', this.apiHeaders())
    ])
    return {
      healthReached: health.reached,
      healthHttpStatus: health.status,
      healthJson: health.json,
      modelReached: model.reached,
      modelHttpStatus: model.status,
      modelJson: model.json
    }
  }

  private async probeJsonPath(
    path: string,
    headers?: Record<string, string>
  ): Promise<{ reached: boolean; status: number | null; json: unknown | null }> {
    try {
      const res = await studioFetch(`${this.baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(5000)
      })
      let json: unknown = null
      try {
        const text = await res.text()
        if (text) json = JSON.parse(text) as unknown
      } catch {
        json = null
      }
      return { reached: true, status: res.status, json }
    } catch {
      return { reached: false, status: null, json: null }
    }
  }

  async getHealth(): Promise<{ status: string; issues: unknown[] }> {
    const res = await studioFetch(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) throw await httpError(res)
    return (await res.json()) as { status: string; issues: unknown[] }
  }

  async listModels(): Promise<ModelSummary[]> {
    const res = await studioFetch(`${this.baseUrl}/v1/model/list`, {
      headers: this.adminHeaders(),
      signal: AbortSignal.timeout(30000)
    })
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as {
      data?: Array<{ id?: string; created?: number }>
    }
    return (data.data ?? []).map((m) => ({
      modelId: m.id ?? 'unknown',
      displayName: m.id ?? 'unknown',
      backend: 'tabby' as const,
      modifiedAt:
        typeof m.created === 'number'
          ? new Date(m.created * 1000).toISOString()
          : undefined
    }))
  }

  async getCurrentModel(): Promise<LoadedModelSummary | null> {
    const res = await studioFetch(`${this.baseUrl}/v1/model`, {
      headers: this.apiHeaders(),
      signal: AbortSignal.timeout(15000)
    })
    if (res.status === 503) return null
    if (!res.ok) {
      // Empty / no model often 200 with null-ish — treat carefully
      if (res.status === 404) return null
      throw await httpError(res)
    }
    const data = (await res.json()) as {
      id?: string
      parameters?: {
        max_seq_len?: number
        cache_size?: number
        cache_mode?: string
        draft?: { id?: string }
      }
    } | null
    if (!data?.id) return null
    return {
      modelId: data.id,
      displayName: data.id,
      backend: 'tabby',
      contextLength: data.parameters?.max_seq_len,
      cacheMode: data.parameters?.cache_mode,
      cacheSize: data.parameters?.cache_size,
      draftModelId: data.parameters?.draft?.id
    }
  }

  async *loadModel(
    options: TabbyLoadOptions
  ): AsyncGenerator<TabbyLoadProgress> {
    const body: Record<string, unknown> = {
      model_name: options.modelName
    }
    if (options.maxSeqLen != null) body.max_seq_len = options.maxSeqLen
    if (options.cacheSize != null) body.cache_size = options.cacheSize
    if (options.cacheMode != null) body.cache_mode = options.cacheMode
    if (options.tensorParallel != null) body.tensor_parallel = options.tensorParallel
    if (options.gpuSplitAuto != null) body.gpu_split_auto = options.gpuSplitAuto
    if (options.gpuSplit?.length) body.gpu_split = options.gpuSplit
    if (options.autosplitReserve?.length) {
      body.autosplit_reserve = options.autosplitReserve
    }
    if (options.ropeScale != null) body.rope_scale = options.ropeScale
    if (options.ropeAlpha != null) body.rope_alpha = options.ropeAlpha
    if (options.chunkSize != null) body.chunk_size = options.chunkSize
    if (options.outputChunking != null) body.output_chunking = options.outputChunking
    if (options.vision != null) body.vision = options.vision
    if (options.promptTemplate != null) body.prompt_template = options.promptTemplate
    if (options.draftModel?.draftModelName) {
      body.draft_model = {
        draft_model_name: options.draftModel.draftModelName,
        ...(options.draftModel.draftRopeScale != null
          ? { draft_rope_scale: options.draftModel.draftRopeScale }
          : {}),
        ...(options.draftModel.draftRopeAlpha != null
          ? { draft_rope_alpha: options.draftModel.draftRopeAlpha }
          : {}),
        ...(options.draftModel.draftGpuSplit?.length
          ? { draft_gpu_split: options.draftModel.draftGpuSplit }
          : {})
      }
    }

    const res = await studioFetch(`${this.baseUrl}/v1/model/load`, {
      method: 'POST',
      headers: this.adminHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600000)
    })
    if (!res.ok) throw await httpError(res)

    const reader = res.body?.getReader()
    if (!reader) {
      yield { module: 1, modules: 1, modelType: 'model', status: 'finished' }
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split(/\n\n/)
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const line = part
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('data:'))
        if (!line) continue
        const payload = line.replace(/^data:\s*/, '')
        if (!payload || payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload) as {
            module?: number
            modules?: number
            model_type?: string
            status?: string
            error?: { message?: string }
          }
          if (json.error?.message) throw new Error(sanitizeUnknownError(json.error.message))
          yield {
            module: json.module ?? 0,
            modules: json.modules ?? 0,
            modelType: json.model_type ?? 'model',
            status: json.status
          }
        } catch (e) {
          if (e instanceof Error && e.message && !e.message.startsWith('HTTP')) {
            throw e
          }
        }
      }
    }
  }

  async unloadModel(): Promise<void> {
    const res = await studioFetch(`${this.baseUrl}/v1/model/unload`, {
      method: 'POST',
      headers: this.adminHeaders(),
      signal: AbortSignal.timeout(120000)
    })
    if (!res.ok) throw await httpError(res)
  }

  async downloadModel(req: TabbyDownloadRequest): Promise<{ downloadPath: string }> {
    const body: Record<string, unknown> = {
      repo_id: req.repoId
    }
    if (req.revision) body.revision = req.revision
    if (req.folderName) body.folder_name = req.folderName
    if (req.token) body.token = req.token
    if (req.include?.length) body.include = req.include
    if (req.exclude?.length) body.exclude = req.exclude

    const res = await studioFetch(`${this.baseUrl}/v1/download`, {
      method: 'POST',
      headers: this.adminHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_600_000),
      longRunning: true
    })
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as { download_path?: string }
    return { downloadPath: data.download_path ?? resolveTabbyModelDir(this.tabby) }
  }

  async encodeTokenCount(text: string): Promise<number | null> {
    try {
      const res = await studioFetch(`${this.baseUrl}/v1/token/encode`, {
        method: 'POST',
        headers: this.apiHeaders(),
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(30000)
      })
      if (!res.ok) return null
      const data = (await res.json()) as { length?: number; tokens?: unknown[] }
      if (typeof data.length === 'number') return data.length
      if (Array.isArray(data.tokens)) return data.tokens.length
      return null
    } catch {
      return null
    }
  }

  async testSpeed(modelId: string): Promise<TabbySpeedTestResult> {
    const current = await this.getCurrentModel()
    if (!current || current.modelId !== modelId) {
      throw new Error(`Model ${modelId} is not loaded`)
    }

    // Warm-up
    await this.chatCompletion(modelId, 'Warm-up. Answer with the single word: ready.', 8)

    const nonce = Date.now().toString(36)
    const prompt = `Hello world! Introduce yourself in three sentences. Reference id ${nonce}.`
    const run = await this.chatCompletion(modelId, prompt, 128)

    const generatedTokens =
      run.usageCompletionTokens ??
      (await this.encodeTokenCount(run.response)) ??
      Math.max(1, Math.round(run.response.split(/\s+/).length * 1.3))

    const promptTokens =
      run.usagePromptTokens ??
      (await this.encodeTokenCount(prompt)) ??
      0

    const genSeconds = Math.max(0.001, (run.totalMs - run.ttftMs) / 1000)

    return {
      model: modelId,
      prompt,
      response: run.response.trim(),
      thinking: '',
      ttftMs: run.ttftMs,
      tokensPerSecond: generatedTokens / genSeconds,
      generatedTokens,
      promptTokensPerSecond: 0,
      promptTokens,
      promptEvalMs: 0,
      totalMs: run.totalMs,
      loadMs: 0,
      wasLoaded: true,
      metricSource: {
        ttft: 'client',
        generationTps: run.usageCompletionTokens != null ? 'usage' : 'client',
        promptTps: 'unavailable',
        tokens:
          run.usageCompletionTokens != null
            ? 'usage'
            : (await this.encodeTokenCount(run.response)) != null
              ? 'tokenizer'
              : 'estimate'
      }
    }
  }

  private async chatCompletion(
    model: string,
    prompt: string,
    maxTokens: number
  ): Promise<{
    response: string
    ttftMs: number
    totalMs: number
    usagePromptTokens: number | null
    usageCompletionTokens: number | null
  }> {
    const startedAt = performance.now()
    const res = await studioFetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.apiHeaders(),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
        stream: true
      }),
      signal: AbortSignal.timeout(300000)
    })
    if (!res.ok) throw await httpError(res)

    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let response = ''
    let firstTokenAt: number | null = null
    let usagePromptTokens: number | null = null
    let usageCompletionTokens: number | null = null

    const consume = (line: string): void => {
      if (!line.startsWith('data:')) return
      const payload = line.replace(/^data:\s*/, '')
      if (!payload || payload === '[DONE]') return
      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const delta = chunk.choices?.[0]?.delta?.content ?? ''
      if (delta) {
        if (firstTokenAt === null) firstTokenAt = performance.now()
        response += delta
      }
      if (chunk.usage) {
        if (typeof chunk.usage.prompt_tokens === 'number') {
          usagePromptTokens = chunk.usage.prompt_tokens
        }
        if (typeof chunk.usage.completion_tokens === 'number') {
          usageCompletionTokens = chunk.usage.completion_tokens
        }
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) consume(line.trim())
      }
    }
    if (buffer.trim()) consume(buffer.trim())

    const finishedAt = performance.now()
    return {
      response,
      ttftMs: Math.max(0, (firstTokenAt ?? finishedAt) - startedAt),
      totalMs: finishedAt - startedAt,
      usagePromptTokens,
      usageCompletionTokens
    }
  }
}

export const tabbyClient = new TabbyClient()
