import { describe, expect, it } from 'vitest'
import { ollamaSizeFromProcessSplit, vramMbForPids } from './loaded-memory'

describe('ollamaSizeFromProcessSplit', () => {
  it('adds RAM and VRAM into total size', () => {
    expect(ollamaSizeFromProcessSplit(2 * 1024 * 1024 * 1024, 10 * 1024 * 1024 * 1024)).toEqual({
      size: 12 * 1024 * 1024 * 1024,
      sizeVram: 10 * 1024 * 1024 * 1024
    })
  })

  it('treats missing measurements as zero so the table can show dashes', () => {
    expect(ollamaSizeFromProcessSplit(0, 0)).toEqual({ size: 0, sizeVram: 0 })
    expect(ollamaSizeFromProcessSplit(Number.NaN, -1)).toEqual({ size: 0, sizeVram: 0 })
  })
})

describe('vramMbForPids', () => {
  it('sums only matching pids with a real measurement', () => {
    expect(
      vramMbForPids(
        [
          { pid: 1, gpuMemoryMb: 100 },
          { pid: 2, gpuMemoryMb: 50 },
          { pid: 1, gpuMemoryMb: 10 },
          { pid: 3, gpuMemoryMb: null },
          { pid: 4, gpuMemoryMb: 999 }
        ],
        [1, 2, 3]
      )
    ).toBe(160)
  })
})
