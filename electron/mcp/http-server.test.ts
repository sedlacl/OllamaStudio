import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'http'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.TEMP ?? process.cwd(),
    getVersion: () => 'test',
    getAppPath: () => process.cwd()
  }
}))

import {
  McpHttpServer,
  isBearerAuthorized,
  validateLocalRequestHeaders
} from './http-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}

describe('MCP HTTP security boundary', () => {
  it('requires an exact bearer token', () => {
    expect(isBearerAuthorized('Bearer secret_token-1', 'secret_token-1')).toBe(true)
    expect(isBearerAuthorized('Bearer wrong', 'secret_token-1')).toBe(false)
    expect(isBearerAuthorized('Basic secret_token-1', 'secret_token-1')).toBe(false)
    expect(isBearerAuthorized(undefined, 'secret_token-1')).toBe(false)
  })

  it('accepts only the configured loopback Host and no Origin', () => {
    expect(validateLocalRequestHeaders({ host: '127.0.0.1:3847' }, 3847)).toEqual({
      ok: true
    })
    expect(validateLocalRequestHeaders({ host: 'localhost:3847' }, 3847)).toMatchObject({
      ok: false,
      status: 421
    })
    expect(
      validateLocalRequestHeaders(
        { host: '127.0.0.1:3847', origin: 'https://example.test' },
        3847
      )
    ).toMatchObject({ ok: false, status: 403 })
  })

  it('runs an authenticated Streamable HTTP session and closes it cleanly', async () => {
    const port = await freePort()
    const server = new McpHttpServer(() => '1.6.0-test')
    const client = new Client({ name: 'http-test', version: '1' })
    try {
      await server.applyConfig({ enabled: true, port, token: 'session-token' })
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        {
          requestInit: {
            headers: { Authorization: 'Bearer session-token' }
          }
        }
      )
      await client.connect(transport)
      const tools = await client.listTools()
      expect(tools.tools).toHaveLength(29)
      await client.close()
    } finally {
      await client.close().catch(() => undefined)
      await server.stop()
    }
  })
})
