import { randomUUID, timingSafeEqual } from 'crypto'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'http'
import type { Socket } from 'net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpConfig } from '../../shared/backend-contract'
import { sanitizeUnknownError } from '../security/sanitize-state'
import { resetMcpRuntimeState, setMcpRuntimeState } from './runtime-state'
import { createStudioMcpServer } from './tools'

const MCP_HOST = '127.0.0.1'
const MCP_PATH = '/mcp'
const MAX_REQUEST_BYTES = 1024 * 1024

interface McpSession {
  server: McpServer
  transport: StreamableHTTPServerTransport
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function isBearerAuthorized(
  authorization: string | string[] | undefined,
  expectedToken: string
): boolean {
  if (!expectedToken) return false
  const value = headerValue(authorization)
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]+)$/)
  if (!match) return false
  const supplied = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function validateLocalRequestHeaders(
  headers: IncomingHttpHeaders,
  port: number
): { ok: true } | { ok: false; status: number; error: string } {
  const host = headerValue(headers.host)?.toLocaleLowerCase('en-US')
  if (host !== `${MCP_HOST}:${port}`) {
    return { ok: false, status: 421, error: 'Invalid Host header' }
  }
  if (headers.origin != null) {
    return { ok: false, status: 403, error: 'Browser origins are not accepted' }
  }
  return { ok: true }
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders?: Record<string, string>
): void {
  if (response.headersSent) return
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  })
  response.end(JSON.stringify(value))
}

function writeRpcError(response: ServerResponse, status: number, message: string): void {
  writeJson(response, status, {
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null
  })
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number.parseInt(headerValue(request.headers['content-length']) ?? '', 10)
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new RequestError(413, 'Request body is too large')
  }

  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buffer.length
    if (received > MAX_REQUEST_BYTES) {
      throw new RequestError(413, 'Request body is too large')
    }
    chunks.push(buffer)
  }
  if (received === 0) throw new RequestError(400, 'Missing JSON request body')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError(400, 'Invalid JSON request body')
  }
}

function isInitializeBody(body: unknown): boolean {
  return (
    body != null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as { method?: unknown }).method === 'initialize'
  )
}

export class McpHttpServer {
  private httpServer: HttpServer | null = null
  private readonly sessions = new Map<string, McpSession>()
  private readonly sockets = new Set<Socket>()
  private transition: Promise<void> = Promise.resolve()

  constructor(private readonly appVersion: () => string) {}

  applyConfig(config: McpConfig): Promise<void> {
    const snapshot = { ...config }
    this.transition = this.transition
      .catch(() => undefined)
      .then(() => this.applyConfigNow(snapshot))
    return this.transition
  }

  stop(): Promise<void> {
    this.transition = this.transition
      .catch(() => undefined)
      .then(() => this.stopNow())
    return this.transition
  }

  private async applyConfigNow(config: McpConfig): Promise<void> {
    await this.stopNow()
    if (!config.enabled) {
      resetMcpRuntimeState()
      return
    }
    await this.startNow(config)
  }

  private async startNow(config: McpConfig): Promise<void> {
    const port = config.port
    const url = `http://${MCP_HOST}:${port}${MCP_PATH}`
    setMcpRuntimeState({
      status: 'starting',
      port,
      url,
      error: null,
      startedAt: null
    })

    const server = createServer((request, response) => {
      void this.handleRequest(request, response, config).catch((error) => {
        if (!response.headersSent) {
          const status = error instanceof RequestError ? error.status : 500
          const message =
            error instanceof RequestError
              ? error.message
              : 'Internal MCP server error'
          writeRpcError(response, status, message)
        } else {
          response.end()
        }
      })
    })
    this.httpServer = server
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, MCP_HOST)
      })
      server.on('error', (error) => {
        setMcpRuntimeState({
          status: 'error',
          port,
          url,
          error: sanitizeUnknownError(error),
          startedAt: null
        })
      })
      setMcpRuntimeState({
        status: 'listening',
        port,
        url,
        error: null,
        startedAt: Date.now()
      })
    } catch (error) {
      if (this.httpServer === server) this.httpServer = null
      setMcpRuntimeState({
        status: 'error',
        port,
        url,
        error: sanitizeUnknownError(error),
        startedAt: null
      })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    config: McpConfig
  ): Promise<void> {
    const path = (request.url ?? '').split('?', 1)[0]
    if (path !== MCP_PATH) {
      writeRpcError(response, 404, 'Not found')
      return
    }

    const envelope = validateLocalRequestHeaders(request.headers, config.port)
    if (!envelope.ok) {
      writeRpcError(response, envelope.status, envelope.error)
      return
    }
    if (!isBearerAuthorized(request.headers.authorization, config.token)) {
      writeRpcError(response, 401, 'Unauthorized')
      response.setHeader('WWW-Authenticate', 'Bearer')
      return
    }
    if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') {
      response.setHeader('Allow', 'POST, GET, DELETE')
      writeRpcError(response, 405, 'Method not allowed')
      return
    }

    const sessionId = headerValue(request.headers['mcp-session-id'])
    if (sessionId) {
      const existing = this.sessions.get(sessionId)
      if (!existing) {
        writeRpcError(response, 404, 'Unknown MCP session')
        return
      }
      await existing.transport.handleRequest(request, response)
      return
    }

    if (request.method !== 'POST') {
      writeRpcError(response, 400, 'Missing MCP session ID')
      return
    }
    const body = await readJsonBody(request)
    if (!isInitializeBody(body)) {
      writeRpcError(response, 400, 'A new MCP session must start with initialize')
      return
    }

    let session: McpSession
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => this.sessions.set(id, session),
      onsessionclosed: (id) => this.sessions.delete(id)
    })
    const mcpServer = createStudioMcpServer(this.appVersion())
    session = { server: mcpServer, transport }
    transport.onclose = () => {
      const id = transport.sessionId
      if (id) this.sessions.delete(id)
    }

    try {
      await mcpServer.connect(transport)
      await transport.handleRequest(request, response, body)
    } catch (error) {
      const id = transport.sessionId
      if (id) this.sessions.delete(id)
      await mcpServer.close().catch(() => undefined)
      throw error
    }
  }

  private async stopNow(): Promise<void> {
    const server = this.httpServer
    this.httpServer = null

    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(sessions.map((session) => session.server.close()))

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const socket of this.sockets) socket.destroy()
      })
    }
    this.sockets.clear()
    resetMcpRuntimeState()
  }
}
