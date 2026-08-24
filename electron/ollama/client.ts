import { loadConfig, parseHostPort } from './config'

export interface ModelTag {
  name: string
  model: string
  modified_at: string
  size: number
  digest: string
  details?: {
    format?: string
    family?: string
    parameter_size?: string
    quantization_level?: string
  }
}

export interface RunningModelDetails {
  parent_model?: string
  format?: string
  family?: string
  families?: string[]
  parameter_size?: string
  quantization_level?: string
}

export interface RunningModel {
  name: string
  model: string
  size: number
  size_vram?: number
  digest: string
  expires_at: string
  context_length?: number
  details?: RunningModelDetails
}

export interface ModelShow {
  modelfile?: string
  parameters?: string
  template?: string
  details?: Record<string, unknown>
  model_info?: Record<string, unknown>
  capabilities?: string[]
}

export interface PullProgress {
  status: string
  digest?: string
  total?: number
  completed?: number
}

export interface ModelLoadOptions {
  keepAlive: string
  numCtx?: number
  numBatch?: number
  numGpu?: number
  numThread?: number
  useMmap?: boolean
  useMlock?: boolean
  ropeFrequencyBase?: number
  ropeFrequencyScale?: number
}

export interface ModelSpeedTestResult {
  model: string
  prompt: string
  response: string
  ttftMs: number
  tokensPerSecond: number
  generatedTokens: number
  totalMs: number
  loadMs: number
  promptTokens: number
}

export type ServeConnectionStatus = 'connected' | 'disconnected' | 'starting' | 'error'

/**
 * Ollama accepts keep_alive as a Go duration string ("30m") or as a JSON number
 * (-1 = forever, 0 = unload, positive = seconds). Bare integer strings like "-1"
 * are parsed as durations and rejected with HTTP 400.
 */
export function encodeKeepAlive(value: string): string | number {
  const trimmed = value.trim()
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  return trimmed
}

async function httpError(res: Response): Promise<Error> {
  let detail = ''
  try {
    const text = (await res.text()).trim()
    if (text) {
      try {
        const json = JSON.parse(text) as { error?: unknown }
        detail = typeof json.error === 'string' && json.error ? `: ${json.error}` : `: ${text}`
      } catch {
        detail = `: ${text}`
      }
    }
  } catch {
    /* ignore body read failures */
  }
  return new Error(`HTTP ${res.status}${detail}`)
}

export class OllamaClient {
  private static readonly VERSION_CACHE_MS = 10_000

  private baseUrl: string
  private versionCache: { value: string; at: number } | null = null
  private versionFetch: Promise<string> | null = null

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? this.resolveBaseUrl()
  }

  refreshBaseUrl(): void {
    this.baseUrl = this.resolveBaseUrl()
    this.versionCache = null
    this.versionFetch = null
  }

  private resolveBaseUrl(): string {
    const config = loadConfig()
    const { host, port } = parseHostPort(config.ollamaEnv.OLLAMA_HOST)
    return `http://${host}:${port}`
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  async ping(): Promise<boolean> {
    try {
      await this.getVersion({ bypassCache: true })
      return true
    } catch {
      return false
    }
  }

  async getConnectionStatus(serveRunning: boolean): Promise<ServeConnectionStatus> {
    if (!serveRunning) return 'disconnected'
    try {
      await this.getVersion()
      return 'connected'
    } catch {
      return serveRunning ? 'starting' : 'disconnected'
    }
  }

  async getVersion(options?: { bypassCache?: boolean }): Promise<string> {
    const bypassCache = options?.bypassCache ?? false
    const now = Date.now()
    if (
      !bypassCache &&
      this.versionCache &&
      now - this.versionCache.at < OllamaClient.VERSION_CACHE_MS
    ) {
      return this.versionCache.value
    }
    if (!bypassCache && this.versionFetch) {
      return this.versionFetch
    }

    const fetchPromise = this.fetchVersion()
    if (!bypassCache) {
      this.versionFetch = fetchPromise
    }

    try {
      const value = await fetchPromise
      if (!bypassCache) {
        this.versionCache = { value, at: Date.now() }
      }
      return value
    } finally {
      if (!bypassCache && this.versionFetch === fetchPromise) {
        this.versionFetch = null
      }
    }
  }

  private async fetchVersion(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as { version?: string }
    return data.version ?? 'unknown'
  }

  async getTags(): Promise<ModelTag[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as { models?: ModelTag[] }
    return data.models ?? []
  }

  async getPs(): Promise<RunningModel[]> {
    const res = await fetch(`${this.baseUrl}/api/ps`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as { models?: RunningModel[] }
    return data.models ?? []
  }

  async show(name: string): Promise<ModelShow> {
    const res = await fetch(`${this.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(30000)
    })
    if (!res.ok) throw await httpError(res)
    return (await res.json()) as ModelShow
  }

  async load(name: string, loadOptions: ModelLoadOptions = { keepAlive: '-1' }): Promise<void> {
    const options: Record<string, number | boolean> = {}
    if (loadOptions.numCtx !== undefined) options.num_ctx = loadOptions.numCtx
    if (loadOptions.numBatch !== undefined) options.num_batch = loadOptions.numBatch
    if (loadOptions.numGpu !== undefined) options.num_gpu = loadOptions.numGpu
    if (loadOptions.numThread !== undefined) options.num_thread = loadOptions.numThread
    if (loadOptions.useMmap !== undefined) options.use_mmap = loadOptions.useMmap
    if (loadOptions.useMlock !== undefined) options.use_mlock = loadOptions.useMlock
    if (loadOptions.ropeFrequencyBase !== undefined) {
      options.rope_frequency_base = loadOptions.ropeFrequencyBase
    }
    if (loadOptions.ropeFrequencyScale !== undefined) {
      options.rope_frequency_scale = loadOptions.ropeFrequencyScale
    }

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: name,
        prompt: '',
        stream: false,
        keep_alive: encodeKeepAlive(loadOptions.keepAlive),
        ...(Object.keys(options).length > 0 ? { options } : {})
      }),
      signal: AbortSignal.timeout(120000)
    })
    if (!res.ok) throw await httpError(res)
  }

  async unload(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, prompt: '', keep_alive: 0 }),
      signal: AbortSignal.timeout(60000)
    })
    if (!res.ok) throw await httpError(res)
  }

  async testSpeed(name: string): Promise<ModelSpeedTestResult> {
    const prompt = 'Hello world! Reply with a short greeting and one sentence about yourself.'
    const startedAt = performance.now()
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: name,
        prompt,
        stream: true,
        options: { num_predict: 96 }
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
    let final: {
      eval_count?: number
      eval_duration?: number
      load_duration?: number
      prompt_eval_count?: number
    } = {}

    const consumeLine = (line: string): void => {
      if (!line.trim()) return
      const chunk = JSON.parse(line) as {
        response?: string
        error?: string
        done?: boolean
        eval_count?: number
        eval_duration?: number
        load_duration?: number
        prompt_eval_count?: number
      }
      if (chunk.error) throw new Error(chunk.error)
      if (chunk.response) {
        if (firstTokenAt === null) firstTokenAt = performance.now()
        response += chunk.response
      }
      if (chunk.done) final = chunk
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeLine(buffer)

    const finishedAt = performance.now()
    const generatedTokens = final.eval_count ?? 0
    const evalSeconds = (final.eval_duration ?? 0) / 1e9
    const tokensPerSecond = evalSeconds > 0 ? generatedTokens / evalSeconds : 0

    return {
      model: name,
      prompt,
      response: response.trim(),
      ttftMs: Math.max(0, (firstTokenAt ?? finishedAt) - startedAt),
      tokensPerSecond,
      generatedTokens,
      totalMs: finishedAt - startedAt,
      loadMs: (final.load_duration ?? 0) / 1e6,
      promptTokens: final.prompt_eval_count ?? 0
    }
  }

  async delete(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(60000)
    })
    if (!res.ok) throw await httpError(res)
  }

  async copy(source: string, destination: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination }),
      signal: AbortSignal.timeout(120000)
    })
    if (!res.ok) throw await httpError(res)
  }

  async *pull(name: string): AsyncGenerator<PullProgress> {
    const res = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true })
    })
    if (!res.ok) throw await httpError(res)
    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          yield JSON.parse(line) as PullProgress
        } catch {
          /* skip malformed */
        }
      }
    }
  }
}

export const ollamaClient = new OllamaClient()
