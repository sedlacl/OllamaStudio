import type { McpConfig } from './backend-contract'

/** Cursor `mcp.json` env substitution — must match project `.cursor/mcp.json`. */
export const OLLAMA_STUDIO_MCP_TOKEN_ENV = 'OLLAMA_STUDIO_MCP_TOKEN'

export const MCP_CURSOR_AUTH_HEADER_PLACEHOLDER = `Bearer ${'${env:OLLAMA_STUDIO_MCP_TOKEN}'}`

export function buildCursorMcpJsonSnippet(config: Pick<McpConfig, 'port'>): string {
  const url = `http://127.0.0.1:${config.port}/mcp`
  return JSON.stringify(
    {
      mcpServers: {
        'ollama-studio': {
          url,
          headers: {
            Authorization: MCP_CURSOR_AUTH_HEADER_PLACEHOLDER
          }
        }
      }
    },
    null,
    2
  )
}
