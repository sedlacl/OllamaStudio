import { describe, expect, it } from 'vitest'
import { isGpuOnlyLoad, reduceTabbyLoadFacts, type TabbyLoadFacts } from './load-facts'
import { ollamaSizeFromLoadFacts } from './loaded-memory'

const EMPTY: TabbyLoadFacts = {
  modelDir: null,
  splitMode: 'unknown',
  singleGpu: false,
  visionOffload: false,
  maxSeqLen: null,
  cacheSize: null,
  loaded: false,
  updatedAt: null
}

function reduceAll(lines: string[], from: TabbyLoadFacts = EMPTY): TabbyLoadFacts {
  return lines.reduce((facts, line, idx) => reduceTabbyLoadFacts(facts, line, idx), from)
}

/** Skutečný sled řádků z loadu Qwen3.8-27B na jedné GPU. */
const SINGLE_GPU_LOAD = [
  'Loading model: D:\\AI\\Tabby\\models\\Qwen3.8-27B-exl3-SC_3.00bpw_H4-2-2-2',
  'Disabling GPU split because one GPU is in use.',
  'Using configured max_seq_len: 65536 tokens.',
  'Using configured cache_size: 65536 tokens.',
  'Loading with a manual GPU split (or a one GPU setup)',
  'Model successfully loaded.'
]

describe('reduceTabbyLoadFacts', () => {
  it('derives the split mode and sizes from a single-GPU load', () => {
    const facts = reduceAll(SINGLE_GPU_LOAD)
    expect(facts.splitMode).toBe('single-gpu')
    expect(facts.singleGpu).toBe(true)
    expect(facts.maxSeqLen).toBe(65536)
    expect(facts.cacheSize).toBe(65536)
    expect(facts.loaded).toBe(true)
    expect(facts.visionOffload).toBe(false)
    expect(isGpuOnlyLoad(facts)).toBe(true)
  })

  it('recognizes autosplit and tensor parallel', () => {
    expect(reduceAll(['Loading with autosplit']).splitMode).toBe('autosplit')
    expect(reduceAll(['Loading with tensor parallel']).splitMode).toBe('tensor-parallel')
  })

  it('drops the previous split when a new load starts', () => {
    const facts = reduceAll(['Loading model: D:\\AI\\Tabby\\models\\other'], reduceAll(SINGLE_GPU_LOAD))
    expect(facts.splitMode).toBe('unknown')
    expect(facts.loaded).toBe(false)
    expect(facts.modelDir).toContain('other')
  })

  it('does not claim GPU-only while vision weights sit in host RAM', () => {
    const facts = reduceAll([
      ...SINGLE_GPU_LOAD,
      'Keeping vision model weights in system RAM (vision_offload).'
    ])
    expect(isGpuOnlyLoad(facts)).toBe(false)
  })

  it('clears loaded on unload', () => {
    const facts = reduceAll([...SINGLE_GPU_LOAD, 'Model unloaded.'])
    expect(facts.loaded).toBe(false)
    expect(isGpuOnlyLoad(facts)).toBe(false)
  })
})

describe('ollamaSizeFromLoadFacts', () => {
  const ram = 5 * 1024 ** 3
  const vram = 13 * 1024 ** 3

  it('reports a GPU-only load without the RAM working set', () => {
    expect(ollamaSizeFromLoadFacts(ram, vram, true)).toEqual({ size: vram, sizeVram: vram })
  })

  it('keeps the measured sum when the log did not confirm GPU-only', () => {
    expect(ollamaSizeFromLoadFacts(ram, vram, false)).toEqual({
      size: ram + vram,
      sizeVram: vram
    })
  })

  it('does not fabricate a size when VRAM was not measured', () => {
    expect(ollamaSizeFromLoadFacts(ram, 0, true)).toEqual({ size: ram, sizeVram: 0 })
  })
})
