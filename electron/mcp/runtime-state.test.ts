import { describe, expect, it } from 'vitest'
import { getMcpRuntimeState, resetMcpRuntimeState, setMcpRuntimeState } from './runtime-state'

describe('MCP runtime state', () => {
  it('starts stopped until http server updates it', () => {
    resetMcpRuntimeState()
    expect(getMcpRuntimeState()).toEqual({
      status: 'stopped',
      port: null,
      url: null,
      error: null,
      startedAt: null
    })
  })

  it('accepts patches from future http server', () => {
    resetMcpRuntimeState()
    setMcpRuntimeState({
      status: 'listening',
      port: 3847,
      url: 'http://127.0.0.1:3847/mcp',
      startedAt: 1
    })
    expect(getMcpRuntimeState().status).toBe('listening')
    resetMcpRuntimeState()
  })
})
