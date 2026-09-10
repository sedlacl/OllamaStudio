import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.TEMP ?? process.cwd(),
    getVersion: () => 'test',
    getAppPath: () => process.cwd()
  }
}))

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { studioMcpHandlers } from './handlers'
import { createStudioMcpServer, STUDIO_TOOL_NAMES } from './tools'

const closeCallbacks: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()))
})

async function connectedPair() {
  const server = createStudioMcpServer('1.5.0-test')
  const client = new Client({ name: 'registry-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  closeCallbacks.push(() => client.close(), () => server.close())
  return client
}

describe('Studio MCP tool registry', () => {
  it('publishes the complete unique tool set', async () => {
    const client = await connectedPair()
    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toHaveLength(29)
    for (const name of STUDIO_TOOL_NAMES) expect(names).toContain(name)
    expect(STUDIO_TOOL_NAMES).toContain('run_test_query')

    for (const name of ['delete_model', 'kill_process', 'stop_server']) {
      expect(tools.tools.find((tool) => tool.name === name)?.annotations?.destructiveHint).toBe(
        true
      )
    }
  })

  it('rejects malformed provider-qualified model input at the SDK boundary', async () => {
    const client = await connectedPair()
    const result = await client.callTool({
      name: 'get_model',
      arguments: { providerId: 'unknown', modelId: '' }
    })
    expect(result.isError).toBe(true)
  })

  it('validates and dispatches run_test_query with schema defaults', async () => {
    const handler = vi.spyOn(studioMcpHandlers, 'runTestQuery').mockResolvedValue({
      providerId: 'ollama',
      modelId: 'llama3',
      text: 'pong',
      truncated: false,
      ttftMs: 12,
      tokensPerSecond: 40,
      generatedTokens: 4,
      promptTokens: 2,
      totalMs: 100
    })
    const client = await connectedPair()
    const result = await client.callTool({
      name: 'run_test_query',
      arguments: {
        providerId: 'ollama',
        modelId: ' llama3 ',
        prompt: ' ping '
      }
    })

    expect(result.isError).not.toBe(true)
    expect(handler).toHaveBeenCalledWith({
      providerId: 'ollama',
      modelId: 'llama3',
      prompt: 'ping',
      maxTokens: 64,
      timeoutMs: 30_000
    })
    expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain('pong')

    const invalid = await client.callTool({
      name: 'run_test_query',
      arguments: {
        providerId: 'ollama',
        modelId: 'llama3',
        prompt: 'ping',
        maxTokens: 513
      }
    })
    expect(invalid.isError).toBe(true)
  })
})
