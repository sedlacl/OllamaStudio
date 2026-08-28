/**
 * Čisté helpery pro převzetí osiřelé TabbyAPI — bez I/O, tokenů a logování.
 */

export const PID_CREATION_TOLERANCE_MS = 15_000

export type ListenerIdentity = 'empty' | 'tabby' | 'foreign'

export type PidCheckResult = 'match' | 'mismatch' | 'missing' | 'stale'

export type TabbyStartAction = 'spawn' | 'adopt' | 'attach-external' | 'conflict'

export interface StoredOwnedPid {
  pid: number
  host: string
  port: number
  pythonPath: string
  installDir: string
  startedAtMs: number
}

export interface LiveProcessInfo {
  pid: number
  alive: boolean
  commandLine: string | null
  creationTimeMs: number | null
}

export interface ListenerProbe {
  portBusy: boolean
  healthReached: boolean
  healthHttpStatus: number | null
  healthJson: unknown | null
  modelReached: boolean
  modelHttpStatus: number | null
  modelJson: unknown | null
}

export function normalizeWinPath(value: string): string {
  return value.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Tabby `/health` vrací `{ status: string, issues: unknown[] }`. */
export function isTabbyHealthBody(json: unknown): boolean {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false
  const body = json as Record<string, unknown>
  return typeof body.status === 'string' && body.status.length > 0 && Array.isArray(body.issues)
}

/**
 * GET `/v1/model` (singulár) je Tabby-specifické — OpenAI používá `/v1/models`.
 * Tělo ani chybová hláška se nikam nekopírují (mohly by obsahovat citlivé údaje).
 */
export function isTabbyModelEndpoint(httpStatus: number | null, json: unknown): boolean {
  if (httpStatus == null) return false
  if (httpStatus === 200) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return false
    const body = json as Record<string, unknown>
    return 'id' in body || 'parameters' in body
  }
  if (httpStatus === 400 || httpStatus === 404 || httpStatus === 422 || httpStatus === 503) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return false
    return 'error' in (json as Record<string, unknown>)
  }
  return false
}

export function classifyListenerProbe(probe: ListenerProbe): ListenerIdentity {
  if (isTabbyHealthBody(probe.healthJson) || isTabbyModelEndpoint(probe.modelHttpStatus, probe.modelJson)) {
    return 'tabby'
  }
  if (probe.healthReached || probe.modelReached || probe.portBusy) return 'foreign'
  return 'empty'
}

export function commandLineLooksLikeTabby(
  commandLine: string | null,
  installDir: string,
  pythonPath: string
): boolean {
  if (!commandLine) return false
  const cl = normalizeWinPath(commandLine)
  if (!cl.includes('main.py')) return false
  const install = normalizeWinPath(installDir)
  const python = normalizeWinPath(pythonPath)
  const hasInstall = install.length > 0 && cl.includes(install)
  const hasPython = python.length > 0 && cl.includes(python)
  return hasInstall || hasPython
}

export function validateStoredPid(
  stored: StoredOwnedPid | null,
  live: LiveProcessInfo | null,
  current: { host: string; port: number; installDir: string; pythonPath: string }
): PidCheckResult {
  if (!stored) return 'missing'
  if (!live || !live.alive) return 'stale'
  if (live.pid !== stored.pid) return 'mismatch'
  if (stored.port !== current.port) return 'mismatch'
  if (normalizeWinPath(stored.host) !== normalizeWinPath(current.host)) return 'mismatch'
  if (
    !commandLineLooksLikeTabby(
      live.commandLine,
      current.installDir || stored.installDir,
      current.pythonPath || stored.pythonPath
    )
  ) {
    return 'mismatch'
  }
  if (
    live.creationTimeMs != null &&
    Number.isFinite(live.creationTimeMs) &&
    Number.isFinite(stored.startedAtMs) &&
    Math.abs(live.creationTimeMs - stored.startedAtMs) > PID_CREATION_TOLERANCE_MS
  ) {
    return 'mismatch'
  }
  return 'match'
}

export function decideTabbyStart(input: {
  listener: ListenerIdentity
  pidCheck: PidCheckResult
}): TabbyStartAction {
  if (input.listener === 'foreign') return 'conflict'
  if (input.listener === 'empty') return 'spawn'
  if (input.pidCheck === 'match') return 'adopt'
  return 'attach-external'
}

export function parseOwnedPidRecord(raw: unknown): StoredOwnedPid | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const pid = o.pid
  const port = o.port
  const host = o.host
  const pythonPath = o.pythonPath
  const installDir = o.installDir
  const startedAtMs = o.startedAtMs
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null
  if (typeof host !== 'string' || host.trim().length === 0) return null
  if (typeof pythonPath !== 'string') return null
  if (typeof installDir !== 'string' || installDir.trim().length === 0) return null
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs) || startedAtMs <= 0) {
    return null
  }
  return {
    pid: pid as number,
    host: host.trim(),
    port: port as number,
    pythonPath,
    installDir: installDir.trim(),
    startedAtMs
  }
}
