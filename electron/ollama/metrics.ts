import { execFile } from 'child_process'
import os from 'os'
import { promisify } from 'util'
import type { OllamaClient } from './client'
import type { ActiveRequest, RequestHistoryItem } from './log-buffer'

const execFileAsync = promisify(execFile)

export interface GpuMetrics {
  /** index z nvidia-smi; null u adaptérů, které nvidia-smi nevidí */
  index: number | null
  /** UUID z nvidia-smi — jediné pojítko mezi kartou a procesy mimo Windows */
  uuid: string | null
  name: string
  memoryUsedMb: number
  memoryTotalMb: number
  utilizationPercent: number | null
}

/**
 * Zobrazovací adaptér Windows. `key` je instance výkonnostních čítačů
 * (`luid_0x00000000_0x00013b1f_phys_0`) — podle ní se per-proces VRAM přiřazuje ke GPU.
 */
export interface GpuAdapter {
  key: string
  name: string
  /** dedikovaná VRAM adaptéru (z DirectX registru) */
  dedicatedTotalMb: number | null
  /** aktuálně využitá dedikovaná paměť adaptéru */
  dedicatedUsedMb: number | null
  /** systémová RAM, kterou adaptér používá jako GPU paměť */
  sharedUsedMb: number | null
  /** metriky z nvidia-smi, pokud jde o NVIDIA kartu */
  nvidia: GpuMetrics | null
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
  return (await getNvidiaGpus())[0] ?? null
}

/** Všechny NVIDIA karty, seřazené podle indexu z nvidia-smi. */
async function getNvidiaGpus(): Promise<GpuMetrics[]> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=index,name,memory.used,memory.total,utilization.gpu,uuid',
        '--format=csv,noheader,nounits'
      ],
      { timeout: 5000, windowsHide: true }
    )
    const gpus: GpuMetrics[] = []
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue
      const [index, name, used, total, util, uuid] = line.split(',').map((s) => s.trim())
      const parsedIndex = parseInt(index, 10)
      gpus.push({
        index: Number.isFinite(parsedIndex) ? parsedIndex : null,
        uuid: uuid || null,
        name: name || 'GPU',
        memoryUsedMb: parseFloat(used) || 0,
        memoryTotalMb: parseFloat(total) || 0,
        utilizationPercent: util ? parseFloat(util) : null
      })
    }
    return gpus.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  } catch {
    return []
  }
}

/**
 * Zobrazovací adaptéry z DirectX registru (jméno + dedikovaná VRAM podle LUID)
 * spárované s čítačem `\GPU Adapter Memory(...)\Dedicated Usage`. LUID v registru
 * je 64bit číslo, instance čítače ho má rozdělené na `luid_0x<high>_0x<low>`.
 */
async function getGpuAdapters(nvidiaGpus: GpuMetrics[]): Promise<GpuAdapter[]> {
  if (process.platform !== 'win32') {
    return nvidiaGpus.map((gpu) => ({
      key: `nvidia-${gpu.index ?? 0}`,
      name: gpu.name,
      dedicatedTotalMb: gpu.memoryTotalMb,
      dedicatedUsedMb: gpu.memoryUsedMb,
      sharedUsedMb: null,
      nvidia: gpu
    }))
  }

  const rows = await runAdapterScript()
  const adapters: GpuAdapter[] = []
  const usedNvidia = new Set<GpuMetrics>()

  for (const row of rows) {
    const nvidia =
      nvidiaGpus.find((g) => !usedNvidia.has(g) && g.name.toLowerCase() === row.name.toLowerCase()) ??
      null
    if (nvidia) usedNvidia.add(nvidia)
    adapters.push({
      key: row.key,
      name: row.name,
      dedicatedTotalMb: nvidia?.memoryTotalMb ?? row.totalMb,
      // nvidia-smi je čerstvější a přesnější než čítač adaptéru
      dedicatedUsedMb: nvidia?.memoryUsedMb ?? row.usedMb,
      sharedUsedMb: row.sharedMb,
      nvidia
    })
  }

  // NVIDIA karty, které registr/čítače nevrátily (jiné jméno, vypnuté čítače)
  for (const gpu of nvidiaGpus) {
    if (usedNvidia.has(gpu)) continue
    adapters.push({
      key: `nvidia-${gpu.index ?? adapters.length}`,
      name: gpu.name,
      dedicatedTotalMb: gpu.memoryTotalMb,
      dedicatedUsedMb: gpu.memoryUsedMb,
      sharedUsedMb: null,
      nvidia: gpu
    })
  }

  return adapters.sort((a, b) => {
    if (a.nvidia && !b.nvidia) return -1
    if (!a.nvidia && b.nvidia) return 1
    return (b.dedicatedTotalMb ?? 0) - (a.dedicatedTotalMb ?? 0)
  })
}

interface AdapterRow {
  key: string
  name: string
  totalMb: number | null
  usedMb: number | null
  sharedMb: number | null
}

/** Výčet adaptérů je drahý (PowerShell + čítače) — držíme ho krátce v cache. */
const ADAPTER_CACHE_MS = 15_000
let adapterCache: { rows: AdapterRow[]; at: number } | null = null

async function runAdapterScript(): Promise<AdapterRow[]> {
  if (adapterCache && Date.now() - adapterCache.at < ADAPTER_CACHE_MS) {
    return adapterCache.rows
  }
  try {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      ...localizedCounterHelper(),
      '$byLuid = @{}',
      "Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\DirectX' | ForEach-Object {",
      '  $p = Get-ItemProperty $_.PSPath',
      '  if ($p.Description -and $null -ne $p.AdapterLuid) {',
      '    $luid = [uint64]$p.AdapterLuid',
      '    $hi = [uint32]($luid -shr 32)',
      '    $lo = [uint32]($luid -band 0xFFFFFFFF)',
      "    $k = 'luid_0x{0:x8}_0x{1:x8}' -f $hi, $lo",
      '    $byLuid[$k] = @($p.Description, [double]$p.DedicatedVideoMemory)',
      '  }',
      '}',
      // Lokalizovaná Windows mají přeložené názvy čítačů, instance luid_* zůstávají stejné.
      "$dedName = 'Dedicated Usage'",
      "$paths = @('\\GPU Adapter Memory(*)\\Dedicated Usage', '\\GPU Adapter Memory(*)\\Shared Usage')",
      '$samples = (Get-Counter -Counter $paths -ErrorAction SilentlyContinue).CounterSamples',
      'if (-not $samples) {',
      "  $setName = Get-LocalizedName 'GPU Adapter Memory'",
      "  $dedName = Get-LocalizedName 'Dedicated Usage'",
      "  $shrName = Get-LocalizedName 'Shared Usage'",
      '  $paths = @("\\$setName(*)\\$dedName", "\\$setName(*)\\$shrName")',
      '  $samples = (Get-Counter -Counter $paths -ErrorAction SilentlyContinue).CounterSamples',
      '}',
      '$dedSuffix = $dedName.ToLower()',
      '$agg = @{}',
      'foreach ($s in $samples) {',
      '  $inst = $s.InstanceName',
      '  if (-not $agg.ContainsKey($inst)) { $agg[$inst] = @(0.0, 0.0) }',
      '  $pair = $agg[$inst]',
      "  if ($s.Path.ToLower().EndsWith($dedSuffix) -or $s.Path.ToLower().EndsWith('dedicated usage')) {",
      '    $pair[0] = $pair[0] + [double]$s.CookedValue',
      '  } else {',
      '    $pair[1] = $pair[1] + [double]$s.CookedValue',
      '  }',
      '  $agg[$inst] = $pair',
      '}',
      '$seen = @{}',
      'foreach ($inst in $agg.Keys) {',
      "  $luid = ($inst -replace '_phys_\\d+$', '')",
      '  $entry = $byLuid[$luid]',
      "  $name = ''",
      '  $total = 0',
      '  if ($entry) { $name = $entry[0]; $total = $entry[1] }',
      '  $seen[$luid] = $true',
      '  $v = $agg[$inst]',
      '  "$inst|$name|$total|$($v[0])|$($v[1])"',
      '}',
      // Adaptéry z registru, které nemají instanci čítače (např. nepoužívané)
      'foreach ($k in $byLuid.Keys) {',
      '  if (-not $seen[$k]) {',
      '    $e = $byLuid[$k]',
      '    "${k}_phys_0|$($e[0])|$($e[1])||"',
      '  }',
      '}'
    ].join('\n')

    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 10000, windowsHide: true }
    )

    const rows: AdapterRow[] = []
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split('|')
      if (parts.length < 4 || !parts[0]) continue
      const totalBytes = parseFloat(parts[2])
      const usedBytes = parseFloat(parts[3])
      const sharedBytes = parseFloat(parts[4] ?? '')
      rows.push({
        key: parts[0].toLowerCase(),
        name: parts[1] || parts[0],
        totalMb: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes / (1024 * 1024) : null,
        usedMb: Number.isFinite(usedBytes) ? usedBytes / (1024 * 1024) : null,
        sharedMb: Number.isFinite(sharedBytes) ? sharedBytes / (1024 * 1024) : null
      })
    }
    adapterCache = { rows, at: Date.now() }
    return rows
  } catch {
    return []
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
  /** rezidentní paměť v VRAM adaptéru; null = zdroj nevrátil číslo */
  gpuMemoryMb: number | null
  source: GpuMemorySource
  /** adaptér, na kterém paměť leží; null = zdroj GPU nerozlišuje */
  adapterKey: string | null
  adapterName: string | null
  /** UUID karty z nvidia-smi; mimo Windows podle něj přiřazujeme proces k adaptéru */
  gpuUuid?: string | null
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
  /** všechny zobrazovací adaptéry včetně iGPU a virtuálních */
  adapters: GpuAdapter[]
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
  serveStatus: string,
  options?: {
    backend?: 'ollama' | 'tabby'
    managedPids?: number[]
  }
): Promise<ResourceUsageData> {
  const backend = options?.backend ?? 'ollama'
  const managedPids = options?.managedPids ?? []
  const [nvidiaGpus, smiRows, perfRows, ollamaProcs, ps, serveMemory, cpu] = await Promise.all([
    getNvidiaGpus(),
    getGpuProcessesFromSmi(),
    getGpuProcessesFromPerfCounters(),
    backend === 'tabby'
      ? getManagedBackendProcesses(servePid, managedPids)
      : getOllamaRelatedProcesses(servePid),
    client.getPs().catch(() => []),
    getProcessMemory(servePid),
    getCpuInfo()
  ])

  const gpu = nvidiaGpus[0] ?? null
  const adapters = await getGpuAdapters(nvidiaGpus)
  const adapterNames = new Map(adapters.map((a) => [a.key, a.name]))
  // Mimo Windows (a v TCC režimu) je UUID jediná vazba procesu na konkrétní kartu.
  const keyByUuid = new Map(
    adapters.filter((a) => a.nvidia?.uuid).map((a) => [a.nvidia?.uuid as string, a.key])
  )
  // Když je NVIDIA jediný adaptér, patří jí i řádky z nvidia-smi bez UUID.
  const soleNvidiaKey = adapters.filter((a) => a.nvidia).length === 1
    ? (adapters.find((a) => a.nvidia)?.key ?? null)
    : null

  const withAdapter = (row: GpuProcess): GpuProcess => {
    const key =
      row.adapterKey ??
      (row.gpuUuid ? keyByUuid.get(row.gpuUuid) ?? null : null) ??
      (row.source === 'nvidia-smi' ? soleNvidiaKey : null)
    return { ...row, adapterKey: key, adapterName: key ? adapterNames.get(key) ?? null : null }
  }

  const smiProcesses = smiRows.map(withAdapter)
  const perfProcesses = perfRows.map(withAdapter)

  const loadedModels = ps.map((p) => ({
    name: p.name,
    sizeVram: p.size_vram ?? 0,
    size: p.size ?? 0
  }))

  const modelVramMb =
    loadedModels.reduce((sum, m) => sum + m.sizeVram, 0) / (1024 * 1024)

  const smiByPid = groupByPid(smiProcesses)
  const perfByPid = groupByPid(perfProcesses)

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
    adapters,
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

interface CpuTimesSample {
  idle: number
  total: number
  at: number
}

/** Poslední odečet, aby se vytížení počítalo přes celý interval mezi obnovami stránky. */
let lastCpuSample: CpuTimesSample | null = null

function sumCpuTimes(list: os.CpuInfo[]): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const c of list) {
    const t = c.times
    idle += t.idle
    // Na Windows je přerušovací čas součástí kernel time, takže by se přičtením počítal dvakrát.
    total += t.user + t.nice + t.sys + t.idle + (process.platform === 'win32' ? 0 : t.irq)
  }
  return { idle, total }
}

function usageBetween(
  before: { idle: number; total: number },
  after: { idle: number; total: number }
): number | null {
  const totalDelta = after.total - before.total
  if (totalDelta <= 0) return null
  const idleDelta = after.idle - before.idle
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
}

/**
 * Vytížení CPU z rozdílu os.cpus() časů. Windows počítadla přes CIM
 * (Win32_PerfFormattedData_*) tady dávala nesmysly — hodnota je počítaná od poslední
 * obnovy WMI provideru, takže okno vzorku je neznámé a čísla skákala (22 % proti
 * skutečným 11 %). os.loadavg() je zase na Windows vždy 0.
 */
async function getCpuInfo(sampleMs = 500): Promise<CpuInfo> {
  const cpus = os.cpus()
  const model = cpus[0]?.model?.trim() || 'CPU'
  const cores = cpus.length

  try {
    const now = Date.now()
    const current = sumCpuTimes(cpus)

    // Průměr od minulého dotazu (obnova stránky) — klidnější než krátký vzorek.
    if (lastCpuSample && now - lastCpuSample.at >= 1000) {
      const usagePercent = usageBetween(lastCpuSample, current)
      lastCpuSample = { ...current, at: now }
      if (usagePercent !== null) return { model, cores, usagePercent }
    }

    // První dotaz nebo dva těsně po sobě: krátký vlastní vzorek.
    await new Promise((resolve) => setTimeout(resolve, sampleMs))
    const after = sumCpuTimes(os.cpus())
    lastCpuSample = { ...after, at: Date.now() }
    return { model, cores, usagePercent: usageBetween(current, after) }
  } catch {
    return { model, cores, usagePercent: null }
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

/**
 * PowerShell helper, který přeloží anglický název čítače na lokalizovaný přes Perflib
 * registr (index je jazykově neutrální). Bez něj by na neanglických Windows selhaly
 * cesty typu `\GPU Process Memory(*)\Local Usage`.
 */
function localizedCounterHelper(): string[] {
  return [
    '$script:PerfNameCache = $null',
    'function Get-LocalizedName([string]$english) {',
    '  if ($null -eq $script:PerfNameCache) {',
    "    $base = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Perflib'",
    "    $en = (Get-ItemProperty \"$base\\009\" -ErrorAction SilentlyContinue).Counter",
    "    $loc = (Get-ItemProperty \"$base\\CurrentLanguage\" -ErrorAction SilentlyContinue).Counter",
    '    $map = @{}',
    '    if ($en -and $loc) {',
    '      $byIndex = @{}',
    '      for ($i = 0; $i -lt $loc.Length - 1; $i += 2) { $byIndex[$loc[$i]] = $loc[$i + 1] }',
    '      for ($i = 0; $i -lt $en.Length - 1; $i += 2) {',
    '        $name = $en[$i + 1]',
    '        if ($name -and -not $map.ContainsKey($name)) {',
    '          $t = $byIndex[$en[$i]]',
    '          if ($t) { $map[$name] = $t }',
    '        }',
    '      }',
    '    }',
    '    $script:PerfNameCache = $map',
    '  }',
    '  $hit = $script:PerfNameCache[$english]',
    '  if ($hit) { return $hit }',
    '  return $english',
    '}'
  ]
}

/** Čítače dávají jméno bez přípony, nvidia-smi celou cestu — sjednocujeme na kratší tvar. */
function displayProcessName(
  pid: number,
  perfByPid: Map<number, GpuProcess[]>,
  smiByPid: Map<number, GpuProcess[]>,
  fallback: string
): string {
  const name = perfByPid.get(pid)?.[0]?.processName ?? smiByPid.get(pid)?.[0]?.processName ?? fallback
  return basenameProcess(name)
}

function groupByPid(rows: GpuProcess[]): Map<number, GpuProcess[]> {
  const map = new Map<number, GpuProcess[]>()
  for (const row of rows) {
    const list = map.get(row.pid)
    if (list) list.push(row)
    else map.set(row.pid, [row])
  }
  return map
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

/**
 * Sloučí Ollama procesy ze všech zdrojů. Proces běžící na více adaptérech dostane
 * řádek pro každý z nich, aby šla VRAM rozlišit podle GPU.
 */
function mergeOllamaProcesses(
  discovered: GpuProcess[],
  smiByPid: Map<number, GpuProcess[]>,
  perfByPid: Map<number, GpuProcess[]>,
  servePid: number | null
): GpuProcess[] {
  const fallbackNames = new Map<number, string>()
  for (const p of discovered) fallbackNames.set(p.pid, p.processName)

  // Doplň Ollama PIDy, které vidí nvidia-smi nebo čítače, ale process-list je nechytil
  for (const rows of [...smiByPid.values(), ...perfByPid.values()]) {
    for (const p of rows) {
      if (fallbackNames.has(p.pid)) continue
      if (!isOllamaRelatedName(p.processName) && p.pid !== servePid) continue
      fallbackNames.set(p.pid, p.processName)
    }
  }

  const out: GpuProcess[] = []
  for (const [pid, fallbackName] of fallbackNames) {
    const processName = displayProcessName(pid, perfByPid, smiByPid, fallbackName)
    const measured = (perfByPid.get(pid) ?? smiByPid.get(pid) ?? []).filter(
      (r) => r.gpuMemoryMb != null
    )
    if (measured.length === 0) {
      out.push({
        pid,
        processName,
        gpuMemoryMb: null,
        source: 'process-list',
        adapterKey: null,
        adapterName: null
      })
      continue
    }
    for (const row of measured) out.push({ ...row, processName })
  }

  return out
}

/**
 * Per-proces VRAM z výkonnostních čítačů Windows, po adaptérech (LUID v instanci).
 *
 * Bereme `Local Usage` = rezidentní paměť na daném adaptéru; její součet přes procesy sedí
 * na nvidia-smi do pár procent. `Dedicated Usage` nepoužíváme, protože na NVIDIA driveru
 * hlásí násobky skutečnosti (~11 GB proti 2,4 GB z nvidia-smi), a `Shared Usage` per proces
 * také ne — kompozitor (dwm) v ní má započítané plochy cizích procesů.
 */
async function getGpuProcessesFromPerfCounters(): Promise<GpuProcess[]> {
  if (process.platform !== 'win32') return []
  try {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      ...localizedCounterHelper(),
      'function Get-GpuSamples {',
      "  $s = (Get-Counter '\\GPU Process Memory(*)\\Local Usage' -ErrorAction SilentlyContinue).CounterSamples",
      '  if ($s) { return $s }',
      // Lokalizovaná Windows mají přeložené názvy čítačů; instance pid_* zůstávají stejné.
      "  $setName = Get-LocalizedName 'GPU Process Memory'",
      "  $local = Get-LocalizedName 'Local Usage'",
      '  return (Get-Counter "\\$setName(*)\\$local" -ErrorAction SilentlyContinue).CounterSamples',
      '}',
      '$agg = @{}',
      'foreach ($s in Get-GpuSamples) {',
      "  if ($s.InstanceName -match '^pid_(\\d+)_(luid_.+)$' -and $s.CookedValue -gt 0) {",
      '    $k = "$($Matches[1])|$($Matches[2])"',
      '    $agg[$k] = [double]$agg[$k] + [double]$s.CookedValue',
      '  }',
      '}',
      'foreach ($k in $agg.Keys) {',
      "  $parts = $k -split '\\|'",
      '  $id = [int]$parts[0]',
      '  $p = Get-Process -Id $id -ErrorAction SilentlyContinue',
      "  $n = ''",
      '  if ($p) { $n = $p.ProcessName }',
      '  "$id|$n|$($agg[$k])|$($parts[1])"',
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
      if (parts.length < 4) continue
      const pid = parseInt(parts[0], 10)
      const localBytes = parseFloat(parts[2])
      if (!Number.isFinite(pid) || !Number.isFinite(localBytes)) continue
      out.push({
        pid,
        processName: parts[1] || `pid ${pid}`,
        gpuMemoryMb: localBytes / (1024 * 1024),
        source: 'perf-counter',
        adapterKey: parts[3] ? parts[3].toLowerCase() : null,
        adapterName: null
      })
    }
    return out
  } catch {
    return []
  }
}

async function getGpuProcessesFromSmi(): Promise<GpuProcess[]> {
  // gpu_uuid umí až novější nvidia-smi; bez něj jen přijdeme o rozlišení karet
  const withUuid = await querySmiComputeApps(true)
  if (withUuid !== null) return withUuid
  return (await querySmiComputeApps(false)) ?? []
}

async function querySmiComputeApps(withUuid: boolean): Promise<GpuProcess[] | null> {
  try {
    const fields = withUuid
      ? 'pid,process_name,used_gpu_memory,gpu_uuid'
      : 'pid,process_name,used_gpu_memory'
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [`--query-compute-apps=${fields}`, '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true }
    )
    const lines = stdout.trim().split('\n').filter(Boolean)
    const processes: GpuProcess[] = []
    for (const line of lines) {
      const parts = line.split(',').map((s) => s.trim())
      // process_name může obsahovat čárky ve vzácných cestách — PID je první, paměť (a UUID) poslední
      if (parts.length < (withUuid ? 4 : 3)) continue
      const uuid = withUuid ? parts[parts.length - 1] : null
      const memStr = withUuid ? parts[parts.length - 2] : parts[parts.length - 1]
      const processName = parts.slice(1, withUuid ? -2 : -1).join(', ')
      const pid = parseInt(parts[0] ?? '', 10)
      if (!Number.isFinite(pid) || !processName || /insufficient permissions/i.test(processName)) {
        continue
      }
      processes.push({
        pid,
        processName,
        gpuMemoryMb: parseGpuMemoryMb(memStr),
        source: 'nvidia-smi',
        adapterKey: null,
        adapterName: null,
        gpuUuid: uuid?.startsWith('GPU-') ? uuid : null
      })
    }
    return processes
  } catch {
    return null
  }
}

/** Serve PID + potomci / procesy se jménem Ollama / llama runner. */
async function getManagedBackendProcesses(
  servePid: number | null,
  managedPids: number[]
): Promise<GpuProcess[]> {
  const pids = new Set<number>(managedPids)
  if (servePid != null) pids.add(servePid)
  if (pids.size === 0) return []

  try {
    if (process.platform === 'win32') {
      const list = [...pids].join(',')
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$ids=@(${list}); Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`
        ],
        { timeout: 8000, windowsHide: true }
      )
      return parsePidNameLines(stdout)
    }

    const out: GpuProcess[] = []
    for (const pid of pids) {
      try {
        const { stdout } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(pid)], {
          timeout: 3000
        })
        out.push({
          pid,
          processName: stdout.trim() || 'python',
          gpuMemoryMb: null,
          source: 'process-list',
          adapterKey: null,
          adapterName: null
        })
      } catch {
        out.push({
          pid,
          processName: 'python',
          gpuMemoryMb: null,
          source: 'process-list',
          adapterKey: null,
          adapterName: null
        })
      }
    }
    return out
  } catch {
    return [...pids].map((pid) => ({
      pid,
      processName: 'python',
      gpuMemoryMb: null,
      source: 'process-list' as const,
      adapterKey: null,
      adapterName: null
    }))
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

    // Linux: serve PID + procesy se jménem ollama / llama-server (+ potomci serve).
    const { stdout } = await execFileAsync(
      'ps',
      ['-eo', 'pid=,ppid=,comm=', '--no-headers'],
      { timeout: 5000 }
    )
    const rows: Array<{ pid: number; ppid: number; name: string }> = []
    const children = new Map<number, number[]>()
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      const pid = parseInt(m[1], 10)
      const ppid = parseInt(m[2], 10)
      const name = m[3].trim()
      if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !name) continue
      rows.push({ pid, ppid, name })
      const list = children.get(ppid) ?? []
      list.push(pid)
      children.set(ppid, list)
    }

    const relatedPids = new Set<number>()
    for (const row of rows) {
      if (isOllamaRelatedName(row.name)) relatedPids.add(row.pid)
    }
    if (servePid != null) {
      relatedPids.add(servePid)
      // BFS potomků serve (runner často není přímé dítě); seen brání zacyklení
      const stack = [servePid]
      const seen = new Set<number>()
      while (stack.length > 0) {
        const current = stack.pop()!
        if (seen.has(current)) continue
        seen.add(current)
        for (const child of children.get(current) ?? []) {
          relatedPids.add(child)
          stack.push(child)
        }
      }
    }

    return rows
      .filter((row) => relatedPids.has(row.pid) && (row.pid === servePid || isOllamaRelatedName(row.name)))
      .map((row) => ({
        pid: row.pid,
        processName: basenameProcess(row.name),
        gpuMemoryMb: null,
        source: 'process-list' as const,
        adapterKey: null,
        adapterName: null
      }))
  } catch {
    if (servePid != null) {
      return [
        {
          pid: servePid,
          processName: 'ollama',
          gpuMemoryMb: null,
          source: 'process-list',
          adapterKey: null,
          adapterName: null
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
      source: 'process-list',
      adapterKey: null,
      adapterName: null
    })
  }
  return out
}
