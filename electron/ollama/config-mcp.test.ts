import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { userDataPath } = vi.hoisted(() => ({
  userDataPath: `${process.env.TEMP ?? process.cwd()}\\ollamastudio-config-mcp-${process.pid}`
}))

vi.mock('electron', () => ({ app: { getPath: () => userDataPath } }))

import {
  DEFAULT_MCP_PORT,
  generateMcpToken,
  loadConfig,
  normalizeMcpPort,
  regenerateMcpToken,
  saveMcpSettings
} from './config'
import { buildCursorMcpJsonSnippet } from '../../shared/mcp-cursor-snippet'

beforeEach(() => rmSync(userDataPath, { recursive: true, force: true }))
afterAll(() => rmSync(userDataPath, { recursive: true, force: true }))

describe('MCP config', () => {
  it('generates opaque tokens', () => {
    const a = generateMcpToken()
    const b = generateMcpToken()
    expect(a.length).toBeGreaterThan(20)
    expect(a).not.toBe(b)
  })

  it('clamps invalid ports to default', () => {
    expect(normalizeMcpPort(80)).toBe(DEFAULT_MCP_PORT)
    expect(normalizeMcpPort(99999)).toBe(DEFAULT_MCP_PORT)
    expect(normalizeMcpPort(4000)).toBe(4000)
  })

  it('migrates legacy config without mcp by persisting token', () => {
    const path = join(userDataPath, 'config.json')
    mkdirSync(userDataPath, { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        configVersion: 3,
        activeBackend: 'ollama',
        providers: {
          ollama: {
            env: {},
            autoStartServe: true,
            profileDefaults: { keepAlive: '30m', numCtx: 131072 }
          },
          tabby: { installDir: 'D:\\AI\\Tabby', host: '127.0.0.1', port: 5000 }
        }
      }),
      'utf-8'
    )

    const config = loadConfig()
    expect(config.mcp?.token.trim()).not.toBe('')
    expect(config.mcp?.port).toBe(DEFAULT_MCP_PORT)
    expect(config.mcp?.enabled).toBe(false)

    const stored = JSON.parse(readFileSync(path, 'utf-8'))
    expect(stored.mcp.token).toBe(config.mcp?.token)
    expect(existsSync(path)).toBe(true)
  })

  it('saveMcpSettings updates enabled and port without clearing token', () => {
    loadConfig()
    const token = loadConfig().mcp!.token
    const saved = saveMcpSettings({ enabled: true, port: 4100 })
    expect(saved.enabled).toBe(true)
    expect(saved.port).toBe(4100)
    expect(saved.token).toBe(token)
  })

  it('regenerateMcpToken replaces token on disk', () => {
    loadConfig()
    const first = saveMcpSettings({ enabled: true })
    const second = regenerateMcpToken()
    expect(second.token).not.toBe(first.token)

    const stored = JSON.parse(readFileSync(join(userDataPath, 'config.json'), 'utf-8'))
    expect(stored.mcp.token).toBe(second.token)
  })

  it('cursor snippet uses localhost url and bearer header', () => {
    const snippet = buildCursorMcpJsonSnippet({ port: 3847, token: 'test-token' })
    const parsed = JSON.parse(snippet) as {
      mcpServers: Record<string, { url: string; headers: { Authorization: string } }>
    }
    expect(parsed.mcpServers['ollama-studio'].url).toBe('http://127.0.0.1:3847/mcp')
    expect(parsed.mcpServers['ollama-studio'].headers.Authorization).toBe('Bearer test-token')
  })
})
