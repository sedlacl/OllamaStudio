import { describe, expect, it } from 'vitest'
import type { ToolConfigMatch } from '../types/api'
import { showsContextWarning } from './ToolConfigIndicators'

function match(partial: Partial<ToolConfigMatch>): ToolConfigMatch {
  return {
    state: 'missing',
    path: 'C:/Users/x/.config/opencode/opencode.jsonc',
    mismatches: [],
    ...partial
  }
}

describe('showsContextWarning', () => {
  it('varuje u modelu, který v configu je', () => {
    expect(showsContextWarning(match({ state: 'current', contextTooSmall: true }))).toBe(true)
    expect(showsContextWarning(match({ state: 'stale', contextTooSmall: true }))).toBe(true)
  })

  it('nevaruje u modelu, který v configu není', () => {
    // Očekávaný kontext se dopočítá z fallbacku, takže contextTooSmall
    // svítí i tam, kde žádný zápis neexistuje.
    expect(showsContextWarning(match({ state: 'missing', contextTooSmall: true }))).toBe(false)
    expect(showsContextWarning(match({ state: 'no-config', contextTooSmall: true }))).toBe(false)
    expect(showsContextWarning(match({ state: 'invalid', contextTooSmall: true }))).toBe(false)
  })

  it('nevaruje bez příznaku ani bez matche', () => {
    expect(showsContextWarning(match({ state: 'current' }))).toBe(false)
    expect(showsContextWarning(undefined)).toBe(false)
  })
})
