import { execFile } from 'child_process'
import { promisify } from 'util'
import type { OllamaClient } from './client'
import type { ActiveRequest } from './log-buffer'

const execFileAsync = promisify(execFile)

export interface GpuMetrics {
  name: string
  memoryUsedMb: number
  memoryTotalMb: number
  utilizationPercent: number | null
}

export interface ProcessMemory {
  workingSetMb: number
  pid: number | null
}

export interface DashboardMetrics {
  gpu: GpuMetrics | null
  vramFallbackMb: number | null
  loadedModels: Array<{ name: string; sizeVram: number }>
  memory: ProcessMemory
  activeRequests: number | null
  activeRequestDetails: ActiveRequest[]
  tokensPerSec: number | null
  uptimeSeconds: number | null
  serveStatus: string
  version: string | null
  loadedCount: number
}

export async function collectMetrics(
  client: OllamaClient,
  servePid: number | null,
  spawnTime: number | null,
  getTokensPerSec: () => number | null,
  getActiveRequestCount: () => number | null,
  getActiveRequestDetails: () => ActiveRequest[],
  serveStatus: string
): Promise<DashboardMetrics> {
  const [gpu, ps, version, memory] = await Promise.all([
    getGpuMetrics(),
    client.getPs().catch(() => []),
    client.getVersion().catch(() => null),
    getProcessMemory(servePid)
  ])

  const loadedModels = ps.map((p) => ({
    name: p.name,
    sizeVram: p.size_vram ?? 0
  }))

  const vramFallbackMb =
    gpu === null && loadedModels.length > 0
      ? loadedModels.reduce((sum, m) => sum + m.sizeVram, 0) / (1024 * 1024)
      : null

  const uptimeSeconds =
    spawnTime !== null ? Math.floor((Date.now() - spawnTime) / 1000) : null

  return {
    gpu,
    vramFallbackMb,
    loadedModels,
    memory,
    activeRequests: getActiveRequestCount(),
    activeRequestDetails: getActiveRequestDetails(),
    tokensPerSec: getTokensPerSec(),
    uptimeSeconds,
    serveStatus,
    version,
    loadedCount: loadedModels.length
  }
}

async function getGpuMetrics(): Promise<GpuMetrics | null> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=name,memory.used,memory.total,utilization.gpu',
        '--format=csv,noheader,nounits'
      ],
      { timeout: 5000, windowsHide: true }
    )
    const line = stdout.trim().split('\n')[0]
    if (!line) return null
    const [name, used, total, util] = line.split(',').map((s) => s.trim())
    return {
      name: name ?? 'GPU',
      memoryUsedMb: parseFloat(used) || 0,
      memoryTotalMb: parseFloat(total) || 0,
      utilizationPercent: util ? parseFloat(util) : null
    }
  } catch {
    return null
  }
}

async function getProcessMemory(pid: number | null): Promise<ProcessMemory> {
  if (pid === null) return { workingSetMb: 0, pid: null }
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`
        ],
        { timeout: 5000, windowsHide: true }
      )
      const bytes = parseInt(stdout.trim(), 10)
      if (Number.isFinite(bytes)) {
        return { workingSetMb: bytes / (1024 * 1024), pid }
      }
    } else {
      const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], {
        timeout: 5000
      })
      const kb = parseInt(stdout.trim(), 10)
      if (Number.isFinite(kb)) {
        return { workingSetMb: (kb * 1024) / (1024 * 1024), pid }
      }
    }
  } catch {
    /* ignore */
  }
  return { workingSetMb: 0, pid }
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
