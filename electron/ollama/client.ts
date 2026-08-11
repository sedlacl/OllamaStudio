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

export interface RunningModel {
  name: string
  model: string
  size: number
  size_vram?: number
  digest: string
  expires_at: string
  details?: Record<string, unknown>
}

export interface ModelShow {
  modelfile?: string
  parameters?: string
  template?: string
  details?: Record<string, unknown>
  model_info?: Record<string, unknown>
}

export interface PullProgress {
  status: string
  digest?: string
  total?: number
  completed?: number
}

export type ServeConnectionStatus = 'connected' | 'disconnected' | 'starting' | 'error'

export class OllamaClient {
  private baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? this.resolveBaseUrl()
  }

  refreshBaseUrl(): void {
    this.baseUrl = this.resolveBaseUrl()
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
      await this.getVersion()
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

  async getVersion(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { version?: string }
    return data.version ?? 'unknown'
  }

  async getTags(): Promise<ModelTag[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { models?: ModelTag[] }
    return data.models ?? []
  }

  async getPs(): Promise<RunningModel[]> {
    const res = await fetch(`${this.baseUrl}/api/ps`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { models?: RunningModel[] }
    return data.models ?? []
  }

  async show(name: string): Promise<ModelShow> {
    const res = await fetch(`${this.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(30000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as ModelShow
  }

  async load(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, prompt: '', keep_alive: -1 }),
      signal: AbortSignal.timeout(120000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  async unload(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, prompt: '', keep_alive: 0 }),
      signal: AbortSignal.timeout(60000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  async delete(name: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(60000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  async copy(source: string, destination: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination }),
      signal: AbortSignal.timeout(120000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  async *pull(name: string): AsyncGenerator<PullProgress> {
    const res = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true })
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
