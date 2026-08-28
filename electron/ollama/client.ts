import { loadConfig, parseHostPort } from './config'
import { studioFetch } from './fetch-error'
import { sanitizeUpdateInfo } from '../security/sanitize-state'

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
  /** Čas do prvního tokenu měřeného běhu — model už je načtený a zahřátý. */
  ttftMs: number
  /** Generování: eval_count / eval_duration z Ollama. */
  tokensPerSecond: number
  generatedTokens: number
  /** Reasoning výstup u modelů s thinking parserem; `response` bývá u nich prázdné. */
  thinking: string
  /** Zpracování promptu: prompt_eval_count / prompt_eval_duration z Ollama. */
  promptTokensPerSecond: number
  promptTokens: number
  promptEvalMs: number
  totalMs: number
  /** Doba načtení modelu do paměti; 0 = model už běžel. */
  loadMs: number
  /** false = model se kvůli testu musel načíst (načtení se do TTFT nepočítá). */
  wasLoaded: boolean
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

interface GenerateMetrics {
  eval_count?: number
  eval_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  load_duration?: number
}

/** Verze Ollama z GitHub Releases + porovnání s běžící instalací. */
export interface OllamaUpdateInfo {
  current: string | null
  latest: string | null
  updateAvailable: boolean
  releaseUrl: string
  checkedAt: number
  error?: string
}

/** Semver porovnání „v0.32.10" vs „0.32.9"; vrací >0 když je `a` novější. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((part) => parseInt(part, 10))
      .filter((part) => Number.isFinite(part))

  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Parametry runneru z /api/generate `options`; musí sedět s načtením, jinak Ollama
 * runner odstřelí a načte znovu.
 *
 * Posílají se jen položky z `api.Runner` (Ollama 0.32): num_ctx, num_batch, num_gpu,
 * main_gpu, use_mmap, num_thread. `use_mlock` a `rope_frequency_*` už API nezná —
 * skončily by jen jako `invalid option provided` v logu serveru.
 */
function buildRunnerOptions(loadOptions: ModelLoadOptions): Record<string, number | boolean> {
  const options: Record<string, number | boolean> = {}
  if (loadOptions.numCtx !== undefined) options.num_ctx = loadOptions.numCtx
  if (loadOptions.numBatch !== undefined) options.num_batch = loadOptions.numBatch
  if (loadOptions.numGpu !== undefined) options.num_gpu = loadOptions.numGpu
  if (loadOptions.numThread !== undefined) options.num_thread = loadOptions.numThread
  if (loadOptions.useMmap !== undefined) options.use_mmap = loadOptions.useMmap
  return options
}

/** Text pro měření promptu — díky `seed` je pokaždé jiný, takže se do něj cache netrefí. */
function benchmarkPayload(seed: string, lines: number): string {
  const rows: string[] = []
  for (let i = 0; i < lines; i++) {
    rows.push(
      `Line ${i + 1} of benchmark payload ${seed}: measuring prompt throughput with filler value ${i * 37 + 11}.`
    )
  }
  return rows.join('\n')
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
  private static readonly UPDATE_CACHE_MS = 6 * 60 * 60 * 1000
  private static readonly RELEASES_URL = 'https://github.com/ollama/ollama/releases/latest'

  private baseUrl: string
  private versionCache: { value: string; at: number } | null = null
  private versionFetch: Promise<string> | null = null
  private updateCache: OllamaUpdateInfo | null = null

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
    const res = await studioFetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as { version?: string }
    return data.version ?? 'unknown'
  }

  /**
   * Porovná běžící Ollama s posledním GitHub Release. Výsledek se drží v cache,
   * aby otevření stránky Server netlouklo na GitHub API (limit pro nepřihlášené).
   */
  async checkForUpdate(options?: { force?: boolean }): Promise<OllamaUpdateInfo> {
    const now = Date.now()
    if (
      !options?.force &&
      this.updateCache &&
      now - this.updateCache.checkedAt < OllamaClient.UPDATE_CACHE_MS
    ) {
      return sanitizeUpdateInfo(this.updateCache)
    }

    let current: string | null = null
    try {
      current = await this.getVersion()
    } catch {
      /* serve neběží — verzi nezjistíme, latest ukážeme stejně */
    }

    const info: OllamaUpdateInfo = {
      current,
      latest: null,
      updateAvailable: false,
      releaseUrl: OllamaClient.RELEASES_URL,
      checkedAt: now
    }

    try {
      const res = await studioFetch('https://api.github.com/repos/ollama/ollama/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) throw await httpError(res)
      const data = (await res.json()) as { tag_name?: string; html_url?: string }
      const latest = data.tag_name?.trim().replace(/^v/i, '') ?? null
      info.latest = latest
      if (data.html_url) info.releaseUrl = data.html_url
      info.updateAvailable =
        latest !== null && current !== null && compareVersions(latest, current) > 0
    } catch (e) {
      info.error = e instanceof Error ? e.message : String(e)
    }

    this.updateCache = sanitizeUpdateInfo(info)
    return this.updateCache
  }

  async getTags(): Promise<ModelTag[]> {
    const res = await studioFetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as { models?: ModelTag[] }
    return data.models ?? []
  }

  async getPs(): Promise<RunningModel[]> {
    const res = await studioFetch(`${this.baseUrl}/api/ps`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as { models?: RunningModel[] }
    return data.models ?? []
  }

  async show(name: string): Promise<ModelShow> {
    const res = await studioFetch(`${this.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(30000)
    })
    if (!res.ok) throw await httpError(res)
    return (await res.json()) as ModelShow
  }

  async load(name: string, loadOptions: ModelLoadOptions = { keepAlive: '-1' }): Promise<void> {
    const options = buildRunnerOptions(loadOptions)

    const res = await studioFetch(`${this.baseUrl}/api/generate`, {
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
    const res = await studioFetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, prompt: '', keep_alive: 0 }),
      signal: AbortSignal.timeout(60000)
    })
    if (!res.ok) throw await httpError(res)
  }

  /**
   * Měření se dělá až na načteném a zahřátém modelu, aby TTFT neobsahoval načtení
   * modelu. TTFT a rychlost generování se berou z krátkého promptu, rychlost
   * zpracování promptu měří `measurePromptSpeed` zvlášť na dlouhém textu.
   * Runner options a keep_alive se přebírají z načtení modelu — jinak by Ollama
   * runner kvůli odlišným parametrům odstřelila a znovu načetla.
   */
  async testSpeed(
    name: string,
    loadOptions?: ModelLoadOptions | null
  ): Promise<ModelSpeedTestResult> {
    const config = loadConfig()
    const keepAlive =
      loadOptions?.keepAlive ?? (config.ollamaEnv.OLLAMA_KEEP_ALIVE.trim() || '5m')
    const runnerOptions = loadOptions ? buildRunnerOptions(loadOptions) : {}

    const running = await this.getPs()
    const wasLoaded = running.some((m) => m.name === name || m.model === name)

    let loadMs = 0
    if (!wasLoaded) {
      const loadStartedAt = performance.now()
      await this.load(name, { ...(loadOptions ?? {}), keepAlive })
      loadMs = performance.now() - loadStartedAt
    }

    // Zahřívací běh: jiný prompt než měřený, aby si měřený běh nesáhl do prompt cache.
    await this.streamGenerate(name, {
      prompt: 'Warm-up. Answer with the single word: ready.',
      keepAlive,
      options: { ...runnerOptions, num_predict: 8, temperature: 0 }
    })

    const nonce = Date.now().toString(36)
    const prompt = `Hello world! Introduce yourself in three sentences. Reference id ${nonce}.`
    const run = await this.streamGenerate(name, {
      prompt,
      keepAlive,
      // Deterministické vzorkování → srovnatelné běhy; num_predict drží délku výstupu.
      options: { ...runnerOptions, num_predict: 128, temperature: 0, seed: 42 }
    })

    const promptSpeed = await this.measurePromptSpeed(name, keepAlive, runnerOptions, nonce)

    const generatedTokens = run.final.eval_count ?? 0
    const evalSeconds = (run.final.eval_duration ?? 0) / 1e9
    const promptTokens = promptSpeed.tokens
    const promptEvalSeconds = promptSpeed.ms / 1000

    return {
      model: name,
      prompt,
      response: run.response.trim(),
      thinking: run.thinking.trim(),
      ttftMs: run.ttftMs,
      tokensPerSecond: evalSeconds > 0 ? generatedTokens / evalSeconds : 0,
      generatedTokens,
      promptTokensPerSecond: promptEvalSeconds > 0 ? promptTokens / promptEvalSeconds : 0,
      promptTokens,
      promptEvalMs: promptEvalSeconds * 1000,
      totalMs: run.totalMs,
      loadMs: wasLoaded ? 0 : loadMs,
      wasLoaded
    }
  }

  /**
   * Ollama hlásí v `prompt_eval_count` celý prompt, ale v `prompt_eval_duration` jen
   * čas tokenů, které runner nenašel v prompt cache — u modelů s dlouhou šablonou
   * pak podíl vychází i o řád vyšší. Měříme proto dvěma běhy se společným prefixem:
   * druhý běh spočítá právě tokeny navíc, takže rozdíl počtů odpovídá naměřenému času.
   */
  private async measurePromptSpeed(
    name: string,
    keepAlive: string,
    runnerOptions: Record<string, number | boolean>,
    nonce: string
  ): Promise<{ tokens: number; ms: number }> {
    // num_predict 1 nechá llama.cpp naměřit 0 ms generování a do logu pak jde
    // zástupná hodnota 1000000 tok/s; pár tokenů navíc stojí zlomek vteřiny.
    const options = { ...runnerOptions, num_predict: 8, temperature: 0 }
    // Zhruba 25 tokenů na řádek; prompt musí zůstat pod kontextem, jinak ho Ollama ořízne
    // a sdílený prefix by se do cache netrefil.
    const numCtx = typeof runnerOptions.num_ctx === 'number' ? runnerOptions.num_ctx : 4096
    const bodyLines = Math.max(8, Math.min(48, Math.floor(numCtx / 75)))
    const prefix = benchmarkPayload(`${nonce}-a`, 6)
    const full = `${prefix}\n${benchmarkPayload(`${nonce}-b`, bodyLines)}`

    const prefixRun = await this.streamGenerate(name, { prompt: prefix, keepAlive, options })
    const fullRun = await this.streamGenerate(name, { prompt: full, keepAlive, options })
    // Stejný prompt podruhé: runner ho musí celý najít v cache. Když ne, cache je
    // vypnutá a rozdíl počtů by rychlost podstřelil — použijeme pak celý prompt.
    const repeatRun = await this.streamGenerate(name, { prompt: full, keepAlive, options })

    const prefixTokens = prefixRun.final.prompt_eval_count ?? 0
    const fullTokens = fullRun.final.prompt_eval_count ?? 0
    const ms = (fullRun.final.prompt_eval_duration ?? 0) / 1e6
    const repeatMs = (repeatRun.final.prompt_eval_duration ?? 0) / 1e6

    const cacheHits = ms > 0 && repeatMs < ms * 0.25
    const tokens = cacheHits && fullTokens > prefixTokens ? fullTokens - prefixTokens : fullTokens
    return { tokens, ms }
  }

  private async streamGenerate(
    name: string,
    request: {
      prompt: string
      keepAlive: string
      options: Record<string, number | boolean>
    }
  ): Promise<{
    response: string
    thinking: string
    ttftMs: number
    totalMs: number
    final: GenerateMetrics
  }> {
    const startedAt = performance.now()
    const res = await studioFetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: name,
        prompt: request.prompt,
        stream: true,
        keep_alive: encodeKeepAlive(request.keepAlive),
        options: request.options
      }),
      signal: AbortSignal.timeout(300000)
    })
    if (!res.ok) throw await httpError(res)

    const reader = res.body?.getReader()
    if (!reader) throw new Error('No response body')

    const decoder = new TextDecoder()
    let buffer = ''
    let response = ''
    let thinking = ''
    let firstTokenAt: number | null = null
    let final: GenerateMetrics = {}

    const consumeLine = (line: string): void => {
      if (!line.trim()) return
      const chunk = JSON.parse(line) as GenerateMetrics & {
        response?: string
        thinking?: string
        error?: string
        done?: boolean
      }
      if (chunk.error) throw new Error(chunk.error)
      // Modely s reasoning parserem (glimmer, harmony…) posílají text v `thinking`,
      // `response` zůstane prázdné — pro TTFT se počítá první token z obojího.
      if (chunk.response || chunk.thinking) {
        if (firstTokenAt === null) firstTokenAt = performance.now()
        response += chunk.response ?? ''
        thinking += chunk.thinking ?? ''
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
    return {
      response,
      thinking,
      ttftMs: Math.max(0, (firstTokenAt ?? finishedAt) - startedAt),
      totalMs: finishedAt - startedAt,
      final
    }
  }

  async delete(name: string): Promise<void> {
    const res = await studioFetch(`${this.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(60000)
    })
    if (!res.ok) throw await httpError(res)
  }

  async copy(source: string, destination: string): Promise<void> {
    const res = await studioFetch(`${this.baseUrl}/api/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination }),
      signal: AbortSignal.timeout(120000)
    })
    if (!res.ok) throw await httpError(res)
  }

  async *pull(name: string): AsyncGenerator<PullProgress> {
    const res = await studioFetch(`${this.baseUrl}/api/pull`, {
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
