import type { McpRuntimeState } from '../../shared/backend-contract'

const STOPPED: McpRuntimeState = {
  status: 'stopped',
  port: null,
  url: null,
  error: null,
  startedAt: null
}

let runtime: McpRuntimeState = { ...STOPPED }

/** Aktuální stav HTTP MCP serveru — napojí modul http-server v další fázi. */
export function getMcpRuntimeState(): McpRuntimeState {
  return { ...runtime }
}

export function setMcpRuntimeState(patch: Partial<McpRuntimeState>): void {
  runtime = { ...runtime, ...patch }
}

export function resetMcpRuntimeState(): void {
  runtime = { ...STOPPED }
}
