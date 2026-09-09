import { describe, expect, it } from 'vitest'
import {
  recommendedOutputLimit,
  resolveTabbyOpenCodeContext,
  TABBY_DEFAULT_CONTEXT_LENGTH
} from './opencode-config'

describe('resolveTabbyOpenCodeContext', () => {
  it('uses last Tabby load max_seq_len', () => {
    expect(
      resolveTabbyOpenCodeContext({
        recordedMaxSeqLen: 32768,
        existingContext: 8192
      })
    ).toBe(32768)
  })

  it('keeps an already written OpenCode limit when the model was not loaded this session', () => {
    expect(resolveTabbyOpenCodeContext({ existingContext: 16384 })).toBe(16384)
  })

  it('falls back to the load-dialog default so OpenCode always gets a window', () => {
    expect(resolveTabbyOpenCodeContext({})).toBe(TABBY_DEFAULT_CONTEXT_LENGTH)
    expect(TABBY_DEFAULT_CONTEXT_LENGTH).toBe(8192)
  })
})

describe('recommendedOutputLimit', () => {
  it('keeps output at a quarter of the Tabby window so compaction does not fire on the first message', () => {
    expect(recommendedOutputLimit(8192)).toBe(2048)
    expect(recommendedOutputLimit(32768)).toBe(8192)
  })
})
