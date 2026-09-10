import { describe, expect, it } from 'vitest'
import {
  isOpenCodeContextTooSmall,
  MIN_OPENCODE_PROMPT_BUDGET,
  recommendedOutputLimit,
  resolveTabbyOpenCodeContext,
  TABBY_DEFAULT_CONTEXT_LENGTH,
  TABBY_DERIVED_CONTEXT_CAP
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

  it('derives the window from the model instead of the 8k fallback', () => {
    expect(resolveTabbyOpenCodeContext({ modelMaxContext: 262144 })).toBe(
      TABBY_DERIVED_CONTEXT_CAP
    )
    expect(resolveTabbyOpenCodeContext({ modelMaxContext: 16384 })).toBe(16384)
  })

  it('prefers the recorded load over a larger model maximum Tabby cannot serve', () => {
    expect(
      resolveTabbyOpenCodeContext({ recordedMaxSeqLen: 8192, modelMaxContext: 262144 })
    ).toBe(8192)
  })

  it('falls back to the load-dialog default so OpenCode always gets a window', () => {
    expect(resolveTabbyOpenCodeContext({})).toBe(TABBY_DEFAULT_CONTEXT_LENGTH)
    expect(TABBY_DEFAULT_CONTEXT_LENGTH).toBe(8192)
  })
})

describe('isOpenCodeContextTooSmall', () => {
  it('flags the 8k window that compacts the session on the first message', () => {
    expect(isOpenCodeContextTooSmall(8192, 2048)).toBe(true)
  })

  it('accepts a window that leaves the agent prompt enough room', () => {
    expect(isOpenCodeContextTooSmall(32768, 8192)).toBe(false)
    expect(isOpenCodeContextTooSmall(TABBY_DERIVED_CONTEXT_CAP, undefined)).toBe(false)
  })

  it('stays quiet when the tool has no context limit written', () => {
    expect(isOpenCodeContextTooSmall(undefined, undefined)).toBe(false)
  })

  it('measures the prompt budget left after limit.output', () => {
    expect(isOpenCodeContextTooSmall(MIN_OPENCODE_PROMPT_BUDGET * 2, MIN_OPENCODE_PROMPT_BUDGET)).toBe(
      false
    )
    expect(
      isOpenCodeContextTooSmall(MIN_OPENCODE_PROMPT_BUDGET * 2, MIN_OPENCODE_PROMPT_BUDGET + 1)
    ).toBe(true)
  })
})

describe('recommendedOutputLimit', () => {
  it('keeps output at a quarter of the Tabby window so compaction does not fire on the first message', () => {
    expect(recommendedOutputLimit(8192)).toBe(2048)
    expect(recommendedOutputLimit(32768)).toBe(8192)
  })
})
