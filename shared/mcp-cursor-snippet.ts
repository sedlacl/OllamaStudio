import type { McpConfig } from './backend-contract'

export function buildCursorMcpJsonSnippet(config: Pick<McpConfig, 'port' | 'token'>): string {
  const url = `http://127.0.0.1:${config.port}/mcp`
  return JSON.stringify(
    {
      mcpServers: {
        'ollama-studio': {
          url,
          headers: {
            Authorization: `Bearer ${config.token}`
          }
        }
      }
    },
    null,
    2
  )
}
