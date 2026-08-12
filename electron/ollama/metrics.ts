import { execFile } from 'child_process'
import os from 'os'
import { promisify } from 'util'
import type { OllamaClient } from './client'
import type { ActiveRequest, RequestHistoryItem } from './log-buffer'

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
  requestHistory: RequestHistoryItem[]
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
  getRequestHistory: () => RequestHistoryItem[],
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
    requestHistory: getRequestHistory(),
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

export interface GpuProcess {
  pid: number
  processName: string
  /** null = nvidia-smi nevrátilo číslo (typicky WDDM [N/A]) */
  gpuMemoryMb: number | null
  source: 'nvidia-smi' | 'process-list'
}

export interface SystemMemory {
  totalMb: number
  freeMb: number
  usedMb: number
}

export interface ResourceUsageData {
  gpu: GpuMetrics | null
  gpuAvailable: boolean
  /** false na Windows WDDM — used_gpu_memory je vždy [N/A] */
  perProcessVramAvailable: boolean
  gpuProcesses: GpuProcess[]
  ollamaProcesses: GpuProcess[]
  vramFallbackMb: number | null
  loadedModels: Array<{ name: string; sizeVram: number; size: number }>
  serveMemory: ProcessMemory
  systemMemory: SystemMemory
  serveStatus: string
}

export async function collectResourceUsage(
  client: OllamaClient,
  servePid: number | null,
  serveStatus: string
): Promise<ResourceUsageData> {
  const [gpu, smiProcesses, ollamaProcs, ps, serveMemory] = await Promise.all([
    getGpuMetrics(),
    getGpuProcessesFromSmi(),
    getOllamaRelatedProcesses(servePid),
    client.getPs().catch(() => []),
    getProcessMemory(servePid)
  ])

  const loadedModels = ps.map((p) => ({
    name: p.name,
    sizeVram: p.size_vram ?? 0,
    size: p.size ?? 0
  }))

  const modelVramMb =
    loadedModels.reduce((sum, m) => sum + m.sizeVram, 0) / (1024 * 1024)

  const perProcessVramAvailable = smiProcesses.some((p) => p.gpuMemoryMb != null)

  // Skuteční spotřebitelé VRAM (známá čísla z nvidia-smi). Na WDDM prázdné.
  const gpuProcesses = smiProcesses
    .filter((p) => p.gpuMemoryMb != null && p.gpuMemoryMb > 0)
    .sort(compareGpuMemoryDesc)

  const smiByPid = new Map(smiProcesses.map((p) => [p.pid, p]))
  const ollamaProcesses = mergeOllamaProcesses(ollamaProcs, smiByPid, servePid).sort(
    compareGpuMemoryDesc
  )

  // Když nvidia-smi neumí per-process VRAM, ale máme /api/ps, označ fallback jasně.
  const vramFallbackMb =
    (!perProcessVramAvailable || gpu === null) && modelVramMb > 0 ? modelVramMb : null

  const totalBytes = os.totalmem()
  const freeBytes = os.freemem()

  return {
    gpu,
    gpuAvailable: gpu !== null,
    perProcessVramAvailable,
    gpuProcesses,
    ollamaProcesses,
    vramFallbackMb,
    loadedModels,
    serveMemory,
    systemMemory: {
      totalMb: totalBytes / (1024 * 1024),
      freeMb: freeBytes / (1024 * 1024),
      usedMb: (totalBytes - freeBytes) / (1024 * 1024)
    },
    serveStatus
  }
}

/** Parsuje used_gpu_memory z CSV; [N/A] / prázdné → null (ne 0). */
export function parseGpuMemoryMb(raw: string | undefined): number | null {
  if (raw == null) return null
  const s = raw.trim()
  if (!s || /^\[?n\/?a\]?$/i.test(s) || /insufficient/i.test(s)) return null
  // "123 MiB" nebo "123"
  const match = s.match(/^([\d.]+)/)
  if (!match) return null
  const n = parseFloat(match[1])
  return Number.isFinite(n) ? n : null
}

function basenameProcess(pathOrName: string): string {
  const normalized = pathOrName.replace(/\\/g, '/')
  const base = normalized.split('/').pop() ?? pathOrName
  return base.trim() || pathOrName
}

function isOllamaRelatedName(name: string): boolean {
  const base = basenameProcess(name).toLowerCase()
  return (
    base.includes('ollama') ||
    base.includes('llama_server') ||
    base.includes('ollama_llama') ||
    /^runner(\.exe)?$/i.test(base) ||
    /llama\.cpp/i.test(base)
  )
}

function compareGpuMemoryDesc(a: GpuProcess, b: GpuProcess): number {
  const av = a.gpuMemoryMb
  const bv = b.gpuMemoryMb
  if (av == null && bv == null) return a.pid - b.pid
  if (av == null) return 1
  if (bv == null) return -1
  return bv - av
}

function mergeOllamaProcesses(
  discovered: GpuProcess[],
  smiByPid: Map<number, GpuProcess>,
  servePid: number | null
): GpuProcess[] {
  const byPid = new Map<number, GpuProcess>()

  for (const p of discovered) {
    const fromSmi = smiByPid.get(p.pid)
    byPid.set(p.pid, {
      pid: p.pid,
      processName: basenameProcess(fromSmi?.processName ?? p.processName),
      gpuMemoryMb: fromSmi?.gpuMemoryMb ?? null,
      source: fromSmi ? 'nvidia-smi' : 'process-list'
    })
  }

  // Doplň Ollama PIDy, které nvidia-smi vidí, ale process-list nechytil
  for (const p of smiByPid.values()) {
    if (!isOllamaRelatedName(p.processName) && p.pid !== servePid) continue
    if (byPid.has(p.pid)) continue
    byPid.set(p.pid, {
      pid: p.pid,
      processName: basenameProcess(p.processName),
      gpuMemoryMb: p.gpuMemoryMb,
      source: 'nvidia-smi'
    })
  }

  return [...byPid.values()]
}

async function getGpuProcessesFromSmi(): Promise<GpuProcess[]> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-compute-apps=pid,process_name,used_gpu_memory',
        '--format=csv,noheader,nounits'
      ],
      { timeout: 5000, windowsHide: true }
    )
    const lines = stdout.trim().split('\n').filter(Boolean)
    const processes: GpuProcess[] = []
    for (const line of lines) {
      const parts = line.split(',').map((s) => s.trim())
      // process_name může obsahovat čárky ve vzácných cestách — PID první, paměť poslední
      if (parts.length < 3) continue
      const pidStr = parts[0]
      const memStr = parts[parts.length - 1]
      const processName = parts.slice(1, -1).join(', ')
      const pid = parseInt(pidStr ?? '', 10)
      if (!Number.isFinite(pid) || !processName || /insufficient permissions/i.test(processName)) {
        continue
      }
      processes.push({
        pid,
        processName,
        gpuMemoryMb: parseGpuMemoryMb(memStr),
        source: 'nvidia-smi'
      })
    }
    return processes
  } catch {
    return []
  }
}

/** Serve PID + potomci / procesy se jménem Ollama / llama runner. */
async function getOllamaRelatedProcesses(servePid: number | null): Promise<GpuProcess[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          [
            "$procs = Get-CimInstance Win32_Process |",
            "  Where-Object {",
            "    $_.Name -match 'ollama|llama_server|ollama_llama|^runner' -or",
            `    ($null -ne ${servePid ?? -1} -and ($_.ProcessId -eq ${servePid ?? -1} -or $_.ParentProcessId -eq ${servePid ?? -1}))`,
            '  };',
            "$procs | ForEach-Object { \"$($_.ProcessId)|$($_.Name)\" }"
          ].join(' ')
        ],
        { timeout: 8000, windowsHide: true }
      )
      // Bez conhost a jiných nesouvisejících dětí — jen serve + Ollama/runner jména
      return parsePidNameLines(stdout).filter(
        (p) => p.pid === servePid || isOllamaRelatedName(p.processName)
      )
    }

    const { stdout } = await execFileAsync(
      'ps',
      ['-eo', 'pid=,comm=', '--no-headers'],
      { timeout: 5000 }
    )
    const all = parsePidNameLines(
      stdout
        .split('\n')
        .map((line) => {
          const m = line.trim().match(/^(\d+)\s+(.+)$/)
          return m ? `${m[1]}|${m[2]}` : ''
        })
        .join('\n')
    )
    return all.filter(
      (p) => p.pid === servePid || isOllamaRelatedName(p.processName)
    )
  } catch {
    if (servePid != null) {
      return [
        {
          pid: servePid,
          processName: 'ollama',
          gpuMemoryMb: null,
          source: 'process-list'
        }
      ]
    }
    return []
  }
}

function parsePidNameLines(stdout: string): GpuProcess[] {
  const out: GpuProcess[] = []
  const seen = new Set<number>()
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [pidStr, ...rest] = trimmed.split('|')
    const pid = parseInt(pidStr ?? '', 10)
    const processName = rest.join('|').trim()
    if (!Number.isFinite(pid) || !processName || seen.has(pid)) continue
    seen.add(pid)
    out.push({
      pid,
      processName: basenameProcess(processName),
      gpuMemoryMb: null,
      source: 'process-list'
    })
  }
  return out
}
