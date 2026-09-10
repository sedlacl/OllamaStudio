/** Živý odhad RAM/VRAM Tabby procesu — TabbyAPI size_vram neposílá. */

import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  getGpuProcessesFromPerfCounters,
  getGpuProcessesFromSmi
} from '../ollama/metrics'
import { getTabbyLoadFacts, isGpuOnlyLoad } from './load-facts'
import { ollamaSizeFromLoadFacts, vramMbForPids } from './loaded-memory'

const execFileAsync = promisify(execFile)

const GPU_PROC_CACHE_MS = 8_000
let gpuProcCache: {
  smi: Awaited<ReturnType<typeof getGpuProcessesFromSmi>>
  perf: Awaited<ReturnType<typeof getGpuProcessesFromPerfCounters>>
  at: number
} | null = null

async function cachedGpuRows(): Promise<{
  smi: Awaited<ReturnType<typeof getGpuProcessesFromSmi>>
  perf: Awaited<ReturnType<typeof getGpuProcessesFromPerfCounters>>
}> {
  if (gpuProcCache && Date.now() - gpuProcCache.at < GPU_PROC_CACHE_MS) {
    return gpuProcCache
  }
  const [smi, perf] = await Promise.all([
    getGpuProcessesFromSmi(),
    getGpuProcessesFromPerfCounters()
  ])
  gpuProcCache = { smi, perf, at: Date.now() }
  return gpuProcCache
}

async function sumWorkingSetBytes(pids: number[]): Promise<number> {
  const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))]
  if (unique.length === 0) return 0
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$ids=@(${unique.join(',')}); (Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum`
        ],
        { timeout: 5000, windowsHide: true }
      )
      const bytes = parseInt(stdout.trim(), 10)
      return Number.isFinite(bytes) && bytes > 0 ? bytes : 0
    }
    let total = 0
    for (const pid of unique) {
      const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], {
        timeout: 3000
      })
      const kb = parseInt(stdout.trim(), 10)
      if (Number.isFinite(kb) && kb > 0) total += kb * 1024
    }
    return total
  } catch {
    return 0
  }
}

export async function estimateProcessMemorySplit(
  pids: number[]
): Promise<{ ramBytes: number; vramBytes: number }> {
  const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))]
  if (unique.length === 0) return { ramBytes: 0, vramBytes: 0 }
  const [ramBytes, gpuRows] = await Promise.all([
    sumWorkingSetBytes(unique),
    cachedGpuRows()
  ])
  const want = new Set(unique)
  const perfHit = gpuRows.perf.some((row) => want.has(row.pid) && row.gpuMemoryMb != null)
  const vramMb = vramMbForPids(perfHit ? gpuRows.perf : gpuRows.smi, unique)
  return { ramBytes, vramBytes: Math.round(vramMb * 1024 * 1024) }
}

export async function tabbyProcessSize(
  pids: number[]
): Promise<{ size: number; sizeVram: number }> {
  const split = await estimateProcessMemorySplit(pids)
  return ollamaSizeFromLoadFacts(
    split.ramBytes,
    split.vramBytes,
    isGpuOnlyLoad(getTabbyLoadFacts())
  )
}
