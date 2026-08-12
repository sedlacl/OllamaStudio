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
  loadedModels: Array<{ name: string; sizeVram: number; size: number }>
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
    sizeVram: p.size_vram ?? 0,
    size: p.size ?? 0
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

export type GpuMemorySource = 'nvidia-smi' | 'perf-counter' | 'process-list'

export interface GpuProcess {
  pid: number
  processName: string
  /** null = zdroj nevrátil číslo (typicky nvidia-smi [N/A] na WDDM) */
  gpuMemoryMb: number | null
  source: GpuMemorySource
}

export interface SystemMemory {
  totalMb: number
  freeMb: number
  usedMb: number
}

export interface CpuInfo {
  model: string
  cores: number
  /** průměrné vytížení všech jader za krátký vzorek, 0–100 */
  usagePercent: number | null
}

export interface ResourceUsageData {
  gpu: GpuMetrics | null
  gpuAvailable: boolean
  /** false, když per-proces VRAM neumí ani nvidia-smi, ani výkonnostní čítače */
  perProcessVramAvailable: boolean
  /** zdroj, ze kterého pocházejí per-proces hodnoty VRAM */
  perProcessSource: GpuMemorySource | null
  /** součet per-proces VRAM; může být vyšší než gpu.memoryUsedMb (sdílené alokace) */
  perProcessVramTotalMb: number | null
  gpuProcesses: GpuProcess[]
  ollamaProcesses: GpuProcess[]
  vramFallbackMb: number | null
  loadedModels: Array<{ name: string; sizeVram: number; size: number }>
  serveMemory: ProcessMemory
  systemMemory: SystemMemory
  cpu: CpuInfo
  serveStatus: string
}

export async function collectResourceUsage(
  client: OllamaClient,
  servePid: number | null,
  serveStatus: string
): Promise<ResourceUsageData> {
  const [gpu, smiProcesses, perfProcesses, ollamaProcs, ps, serveMemory, cpu] = await Promise.all([
    getGpuMetrics(),
    getGpuProcessesFromSmi(),
    getGpuProcessesFromPerfCounters(),
    getOllamaRelatedProcesses(servePid),
    client.getPs().catch(() => []),
    getProcessMemory(servePid),
    getCpuInfo()
  ])

  const loadedModels = ps.map((p) => ({
    name: p.name,
    sizeVram: p.size_vram ?? 0,
    size: p.size ?? 0
  }))

  const modelVramMb =
    loadedModels.reduce((sum, m) => sum + m.sizeVram, 0) / (1024 * 1024)

  const smiByPid = new Map(smiProcesses.map((p) => [p.pid, p]))
  const perfByPid = new Map(perfProcesses.map((p) => [p.pid, p]))

  // Výkonnostní čítače Windows fungují i na WDDM, kde nvidia-smi vrací [N/A].
  const perProcessSource: GpuMemorySource | null = perfProcesses.some(
    (p) => p.gpuMemoryMb != null
  )
    ? 'perf-counter'
    : smiProcesses.some((p) => p.gpuMemoryMb != null)
      ? 'nvidia-smi'
      : null
  const perProcessVramAvailable = perProcessSource !== null

  const gpuProcesses = (perProcessSource === 'perf-counter' ? perfProcesses : smiProcesses)
    // Alokace pod 1 MB jsou režie ovladače, ne reálná spotřeba aplikace
    .filter((p) => p.gpuMemoryMb != null && p.gpuMemoryMb >= MIN_LISTED_VRAM_MB)
    .map((p) => ({ ...p, processName: displayProcessName(p.pid, perfByPid, smiByPid, p.processName) }))
    .sort(compareGpuMemoryDesc)

  const perProcessVramTotalMb = perProcessVramAvailable
    ? gpuProcesses.reduce((sum, p) => sum + (p.gpuMemoryMb ?? 0), 0)
    : null

  const ollamaProcesses = mergeOllamaProcesses(
    ollamaProcs,
    smiByPid,
    perfByPid,
    servePid
  ).sort(compareGpuMemoryDesc)

  // Fallback na /api/ps jen tehdy, když per-proces VRAM opravdu nemáme z žádného zdroje.
  const vramFallbackMb =
    (!perProcessVramAvailable || gpu === null) && modelVramMb > 0 ? modelVramMb : null

  const totalBytes = os.totalmem()
  const freeBytes = os.freemem()

  return {
    gpu,
    gpuAvailable: gpu !== null,
    perProcessVramAvailable,
    perProcessSource,
    perProcessVramTotalMb,
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
    cpu,
    serveStatus
  }
}

/**
 * Vytížení CPU napříč jádry z rozdílu os.cpus() časů přes krátký vzorek.
 * os.loadavg() je na Windows vždy 0, proto počítáme z idle/total delty.
 */
async function getCpuInfo(sampleMs = 500): Promise<CpuInfo> {
  const cpus = os.cpus()
  const model = cpus[0]?.model?.trim() || 'CPU'
  const cores = cpus.length

  if (process.platform === 'win32') {
    const perf = await getWindowsCpuUsage()
    if (perf !== null) return { model, cores, usagePercent: perf }
  }

  const sum = (list: os.CpuInfo[]): { idle: number; total: number } => {
    let idle = 0
    let total = 0
    for (const c of list) {
      const t = c.times
      idle += t.idle
      total += t.user + t.nice + t.sys + t.idle + t.irq
    }
    return { idle, total }
  }

  try {
    const a = sum(cpus)
    await new Promise((resolve) => setTimeout(resolve, sampleMs))
    const b = sum(os.cpus())
    const idleDelta = b.idle - a.idle
    const totalDelta = b.total - a.total
    const usagePercent =
      totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : null
    return { model, cores, usagePercent }
  } catch {
    return { model, cores, usagePercent: null }
  }
}

/**
 * Vytížení CPU na Windows přes CIM (Win32_PerfFormattedData_PerfOS_Processor).
 * Názvy třídy/vlastnosti jsou jazykově neutrální (na rozdíl od cest Get-Counter),
 * hodnota `_Total` je předpočtená a odpovídá Správci úloh. null → fallback na os.cpus().
 */
async function getWindowsCpuUsage(): Promise<number | null> {
  try {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$t = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | Where-Object { $_.Name -eq '_Total' }",
      'if ($t) { [int]$t.PercentProcessorTime }'
    ].join('\n')

    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 8000, windowsHide: true }
    )

    const n = parseFloat(stdout.trim())
    if (!Number.isFinite(n)) return null
    return Math.max(0, Math.min(100, n))
  } catch {
    return null
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

/** Alokace menší než tato hodnota nepovažujeme za spotřebu aplikace. */
const MIN_LISTED_VRAM_MB = 1

/** Čítače dávají jméno bez přípony, nvidia-smi celou cestu — sjednocujeme na kratší tvar. */
function displayProcessName(
  pid: number,
  perfByPid: Map<number, GpuProcess>,
  smiByPid: Map<number, GpuProcess>,
  fallback: string
): string {
  const name = perfByPid.get(pid)?.processName ?? smiByPid.get(pid)?.processName ?? fallback
  return basenameProcess(name)
}

function basenameProcess(pathOrName: string): string {
  const normalized = pathOrName.replace(/\\/g, '/')
  const base = normalized.split('/').pop() ?? pathOrName
  return base.trim() || pathOrName
}

export function isOllamaRelatedName(name: string): boolean {
  const base = basenameProcess(name).toLowerCase()
  return (
    base.includes('ollama') ||
    // runner se podle verze jmenuje llama-server.exe, llama_server nebo ollama_llama_server
    /llama[-_. ]?server/.test(base) ||
    /llama[-_.]?cpp/.test(base) ||
    /^runner(\.exe)?$/.test(base)
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
  perfByPid: Map<number, GpuProcess>,
  servePid: number | null
): GpuProcess[] {
  const byPid = new Map<number, GpuProcess>()

  const resolve = (pid: number, fallbackName: string): GpuProcess => {
    const perfMb = perfByPid.get(pid)?.gpuMemoryMb ?? null
    const smiMb = smiByPid.get(pid)?.gpuMemoryMb ?? null
    return {
      pid,
      processName: displayProcessName(pid, perfByPid, smiByPid, fallbackName),
      gpuMemoryMb: perfMb ?? smiMb,
      source: perfMb != null ? 'perf-counter' : smiMb != null ? 'nvidia-smi' : 'process-list'
    }
  }

  for (const p of discovered) {
    byPid.set(p.pid, resolve(p.pid, p.processName))
  }

  // Doplň Ollama PIDy, které vidí nvidia-smi nebo čítače, ale process-list je nechytil
  for (const p of [...smiByPid.values(), ...perfByPid.values()]) {
    if (!isOllamaRelatedName(p.processName) && p.pid !== servePid) continue
    if (byPid.has(p.pid)) continue
    byPid.set(p.pid, resolve(p.pid, p.processName))
  }

  return [...byPid.values()]
}

/**
 * Per-proces VRAM z výkonnostních čítačů Windows (\GPU Process Memory\Dedicated Usage).
 * Na rozdíl od nvidia-smi vrací na WDDM skutečná čísla. Hodnoty se sčítají přes všechny
 * instance (adaptéry) jednoho PID.
 */
async function getGpuProcessesFromPerfCounters(): Promise<GpuProcess[]> {
  if (process.platform !== 'win32') return []
  try {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'function Get-GpuSamples {',
      "  $s = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples",
      '  if ($s) { return $s }',
      // Lokalizované Windows mají přeložené názvy čítačů; instance pid_* zůstávají stejné.
      "  $set = Get-Counter -ListSet * -ErrorAction SilentlyContinue | Where-Object { $_.Paths -match '\\(pid_' } | Select-Object -First 1",
      '  if (-not $set) { return @() }',
      "  $path = $set.Counter | Where-Object { $_ -match 'Dedicated' } | Select-Object -First 1",
      '  if (-not $path) { $path = $set.Counter | Select-Object -First 1 }',
      '  return (Get-Counter $path -ErrorAction SilentlyContinue).CounterSamples',
      '}',
      '$agg = @{}',
      'foreach ($s in Get-GpuSamples) {',
      "  if ($s.InstanceName -match 'pid_(\\d+)_' -and $s.CookedValue -gt 0) {",
      '    $id = [int]$Matches[1]',
      '    $agg[$id] = [double]$agg[$id] + [double]$s.CookedValue',
      '  }',
      '}',
      'foreach ($k in $agg.Keys) {',
      '  $p = Get-Process -Id $k -ErrorAction SilentlyContinue',
      "  $n = ''",
      '  if ($p) { $n = $p.ProcessName }',
      '  "$k|$n|$($agg[$k])"',
      '}'
    ].join('\n')

    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 10000, windowsHide: true }
    )

    const out: GpuProcess[] = []
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split('|')
      if (parts.length < 3) continue
      const pid = parseInt(parts[0], 10)
      const bytes = parseFloat(parts[2])
      if (!Number.isFinite(pid) || !Number.isFinite(bytes)) continue
      out.push({
        pid,
        processName: parts[1] || `pid ${pid}`,
        gpuMemoryMb: bytes / (1024 * 1024),
        source: 'perf-counter'
      })
    }
    return out
  } catch {
    return []
  }
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
            "    $_.Name -match 'ollama|llama[-_. ]?server|llama[-_.]?cpp|^runner' -or",
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
