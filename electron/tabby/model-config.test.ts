import { describe, expect, it } from 'vitest'
import { applyModelAgentYaml } from './model-config'

describe('applyModelAgentYaml', () => {
  it('creates a model section when the file is empty', () => {
    const out = applyModelAgentYaml('', { enabled: true })
    expect(out).toContain('reasoning: true')
    expect(out).toContain('tool_format: qwen3_5')
    expect(out).toContain('reasoning_start_token: "<think>"')
  })

  it('keeps draft_model and other model keys', () => {
    const raw = `model:\n  max_seq_len: 8192\n\ndraft_model:\n  draft_mode: mtp\n`
    const out = applyModelAgentYaml(raw, { enabled: true, toolFormat: 'qwen3_5' })
    expect(out).toMatch(/max_seq_len:\s*8192/)
    expect(out).toMatch(/draft_mode:\s*mtp/)
    expect(out).toMatch(/tool_format:\s*qwen3_5/)
  })

  it('clears tool parser keys when disabled', () => {
    const raw = applyModelAgentYaml('', { enabled: true })
    const out = applyModelAgentYaml(raw, { enabled: false })
    expect(out).toContain('reasoning: false')
    expect(out).not.toContain('tool_format:')
    expect(out).not.toContain('reasoning_start_token:')
  })
})
