import { afterAll, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'fs'

const { userDataPath } = vi.hoisted(() => ({
  userDataPath: `${process.env.TEMP ?? process.cwd()}\\ollamastudio-test-query-${process.pid}`
}))

const studioFetch = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

vi.mock('../ollama/fetch-error', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ollama/fetch-error')>()
  return { ...actual, studioFetch }
})

import { OllamaClient } from '../ollama/client'
import { TabbyClient } from '../tabby/client'
import {
  parseTestQueryRequest,
  runTestQuery,
  TEST_QUERY_DEFAULT_MAX_TOKENS,
  TEST_QUERY_MAX_OUTPUT_CHARS,
  TestQueryError
} from './test-query'

afterAll(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

function streamResponse(chunks: string[], url: string, contentType: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType }
  })
}

describe('parseTestQueryRequest', () => {
  it('accepts ModelRef plus prompt/maxTokens/timeout', () => {
    expect(
      parseTestQueryRequest({
        ref: { providerId: 'tabby', modelId: ' qwen ' },
        prompt: ' ping ',
        maxTokens: 32,
        timeoutMs: 5000
      })
    ).toEqual({
      ref: { providerId: 'tabby', modelId: 'qwen' },
      prompt: 'ping',
      maxTokens: 32,
      timeoutMs: 5000
    })
  })

  it('rejects out-of-range limits and fills defaults', () => {
    expect(
      parseTestQueryRequest({
        providerId: 'ollama',
        modelId: 'llama',
        prompt: 'hi'
      }).maxTokens
    ).toBe(TEST_QUERY_DEFAULT_MAX_TOKENS)
    expect(() =>
      parseTestQueryRequest({
        providerId: 'ollama',
        modelId: 'llama',
        prompt: 'hi',
        maxTokens: 9999
      })
    ).toThrow(/maxTokens/)
    expect(() =>
      parseTestQueryRequest({
        providerId: 'ollama',
        modelId: 'llama',
        prompt: 'hi',
        timeout: 50
      })
    ).toThrow(/timeoutMs/)
  })

  it('rejects bad refs and empty prompts', () => {
    expect(() => parseTestQueryRequest({ prompt: 'x' })).toThrow(TestQueryError)
    expect(() =>
      parseTestQueryRequest({ providerId: 'ollama', modelId: 'a\0b', prompt: 'x' })
    ).toThrow(/INVALID_MODEL_REFERENCE|Invalid model/)
    expect(() =>
      parseTestQueryRequest({ providerId: 'ollama', modelId: 'm', prompt: '   ' })
    ).toThrow(/prompt is required/)
  })
})

describe('runTestQuery', () => {
  it('truncates sanitized text and returns metrics from the provider', async () => {
    const runTestQueryImpl = vi.fn(async () => ({
      text: 'a'.repeat(TEST_QUERY_MAX_OUTPUT_CHARS + 20),
      thinking: '',
      ttftMs: 12.5,
      totalMs: 100,
      generatedTokens: 8,
      tokensPerSecond: 40,
      promptTokens: 3
    }))

    const result = await runTestQuery(
      { providerId: 'ollama', modelId: 'llama3', prompt: 'hello', maxTokens: 16 },
      { getProvider: () => ({ runTestQuery: runTestQueryImpl }) }
    )

    expect(runTestQueryImpl).toHaveBeenCalledWith('llama3', {
      prompt: 'hello',
      maxTokens: 16,
      timeoutMs: 30_000
    })
    expect(result.text).toHaveLength(TEST_QUERY_MAX_OUTPUT_CHARS)
    expect(result.truncated).toBe(true)
    expect(result.ttftMs).toBe(12.5)
    expect(result.tokensPerSecond).toBe(40)
    expect(result.generatedTokens).toBe(8)
    expect(result.promptTokens).toBe(3)
    expect(result.providerId).toBe('ollama')
  })

  it('maps abort to TEST_QUERY_TIMEOUT', async () => {
    const err = new Error('aborted')
    err.name = 'TimeoutError'
    await expect(
      runTestQuery(
        { providerId: 'tabby', modelId: 'm', prompt: 'x' },
        {
          getProvider: () => ({
            runTestQuery: async () => {
              throw err
            }
          })
        }
      )
    ).rejects.toMatchObject({ code: 'TEST_QUERY_TIMEOUT' })
  })

  it('drops non-finite metrics', async () => {
    const result = await runTestQuery(
      { providerId: 'ollama', modelId: 'm', prompt: 'x' },
      {
        getProvider: () => ({
          runTestQuery: async () => ({
            text: 'ok',
            thinking: '',
            ttftMs: Number.NaN,
            totalMs: 9,
            generatedTokens: null,
            tokensPerSecond: Number.POSITIVE_INFINITY,
            promptTokens: null
          })
        })
      }
    )
    expect(result.text).toBe('ok')
    expect(result.truncated).toBe(false)
    expect(result.ttftMs).toBeNull()
    expect(result.tokensPerSecond).toBeNull()
    expect(result.generatedTokens).toBeNull()
  })
})

describe('Ollama generateTestQuery via mocked fetch', () => {
  it('POSTs /api/generate and reads TTFT/TPS from NDJSON', async () => {
    studioFetch.mockImplementation(async (url: string) => {
      expect(String(url)).toContain('/api/generate')
      return streamResponse(
        [
          '{"response":"Hel"}\n',
          '{"response":"lo","eval_count":4,"eval_duration":1000000000,"prompt_eval_count":6,"done":true}\n'
        ],
        String(url),
        'application/x-ndjson'
      )
    })

    const client = new OllamaClient('http://127.0.0.1:11434')
    const result = await client.generateTestQuery('llama3', {
      prompt: 'say hi',
      maxTokens: 8,
      timeoutMs: 5000
    })

    expect(result.text).toBe('Hello')
    expect(result.generatedTokens).toBe(4)
    expect(result.tokensPerSecond).toBe(4)
    expect(result.promptTokens).toBe(6)
    expect(result.ttftMs).toBeGreaterThanOrEqual(0)

    const init = studioFetch.mock.calls[0][1] as { body: string }
    const body = JSON.parse(init.body) as {
      model: string
      prompt: string
      options: { num_predict: number }
    }
    expect(body.model).toBe('llama3')
    expect(body.prompt).toBe('say hi')
    expect(body.options.num_predict).toBe(8)
  })
})

describe('Tabby generateTestQuery via mocked fetch', () => {
  it('POSTs /v1/chat/completions and uses usage metrics', async () => {
    studioFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/v1/model')) {
        return new Response(JSON.stringify({ id: 'qwen' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      expect(String(url)).toContain('/v1/chat/completions')
      return streamResponse(
        [
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
          'data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n',
          'data: [DONE]\n'
        ],
        String(url),
        'text/event-stream'
      )
    })

    const client = new TabbyClient()
    const result = await client.generateTestQuery('qwen', {
      prompt: 'ping',
      maxTokens: 16,
      timeoutMs: 4000
    })

    expect(result.text).toBe('Hi')
    expect(result.generatedTokens).toBe(2)
    expect(result.promptTokens).toBe(3)
    expect(result.tokensPerSecond).not.toBeNull()
  })
})
