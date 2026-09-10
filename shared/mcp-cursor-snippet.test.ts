import { describe, expect, it } from 'vitest'
import {
  MCP_CURSOR_AUTH_HEADER_PLACEHOLDER,
  OLLAMA_STUDIO_MCP_TOKEN_ENV,
  buildCursorMcpJsonSnippet
} from './mcp-cursor-snippet'

describe('buildCursorMcpJsonSnippet', () => {
  const sentinelToken = 'SENTINEL-MCP-TOKEN-MUST-NOT-LEAK-9f3a2b1c'

  it('uses env placeholder instead of embedding a bearer token', () => {
    const snippet = buildCursorMcpJsonSnippet({ port: 3847 })
    expect(snippet).not.toContain(sentinelToken)
    expect(snippet).toContain('${env:OLLAMA_STUDIO_MCP_TOKEN}')
    expect(MCP_CURSOR_AUTH_HEADER_PLACEHOLDER).toBe(
      `Bearer ${'${env:' + OLLAMA_STUDIO_MCP_TOKEN_ENV + '}'}`
    )

    const parsed = JSON.parse(snippet) as {
      mcpServers: Record<string, { url: string; headers: { Authorization: string } }>
    }
    expect(parsed.mcpServers['ollama-studio'].url).toBe('http://127.0.0.1:3847/mcp')
    expect(parsed.mcpServers['ollama-studio'].headers.Authorization).toBe(
      MCP_CURSOR_AUTH_HEADER_PLACEHOLDER
    )
  })
})
