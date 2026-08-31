import {
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
  type WriteStream
} from 'fs'
import { join, resolve } from 'path'
import { logBuffer } from '../ollama/log-buffer'
import {
  assertKnownLogFile,
  scrubStudioLogFiles,
  type ScrubResult
} from './log-scrub'

export type StudioLogFileName = 'ollama-serve.log' | 'tabby-serve.log'

export class StudioLogPersistenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioLogPersistenceError'
  }
}

let scrubbedDir: string | null = null
let activeWriter: WriteStream | null = null
let activeLogFile: StudioLogFileName | null = null
let mutexTail: Promise<void> = Promise.resolve()

function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutexTail.then(fn)
  mutexTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Sdílený mutex pro start/stop backendu, scrub/delete runtime logů a clear. */
export function withBackendLogMutex<T>(fn: () => Promise<T>): Promise<T> {
  return withMutex(fn)
}

function assertStudioLogPath(
  logsDir: string,
  fileName: StudioLogFileName
): { ok: true; logPath: string; allowedRoots: string[] } | { ok: false; reason: string } {
  const canonicalDir = resolve(logsDir)
  const allowedRoots = [canonicalDir]
  const logPath = join(canonicalDir, fileName)
  const guard = assertKnownLogFile(logPath, allowedRoots)
  if (!guard.ok) return guard
  const reopenGuard = assertKnownLogFile(logPath, allowedRoots)
  if (!reopenGuard.ok) return reopenGuard
  return { ok: true, logPath, allowedRoots }
}

function assertScrubSucceeded(results: ScrubResult[]): void {
  const failed = results.find((result) => !result.ok)
  if (failed) {
    throw new StudioLogPersistenceError(failed.error ?? 'scrub failed')
  }
}

async function scrubOnce(logsDir: string): Promise<void> {
  const resolved = resolve(logsDir)
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true })
  if (scrubbedDir === resolved) return
  const results = await scrubStudioLogFiles(resolved)
  assertScrubSucceeded(results)
  scrubbedDir = resolved
}

/**
 * Jednorázový scrub historických Studio logů — volat až po registraci známých auth secretů.
 * Žádný writer se neotevře dřív než dokončí scrub. Selhání scrubu = fail-closed bez writeru.
 */
export function prepareStudioLogScrub(logsDir: string): Promise<void> {
  return withMutex(() => scrubOnce(logsDir))
}

/** Otevře append writer pro aktivní backend — až po dokončeném scrubu a canonical path guardu. */
export async function openStudioLogWriter(
  logsDir: string,
  fileName: StudioLogFileName
): Promise<void> {
  return withMutex(async () => {
    await scrubOnce(logsDir)
    if (activeWriter && activeLogFile === fileName) return
    if (activeWriter) {
      closeStudioLogWriter()
    }
    const guarded = assertStudioLogPath(logsDir, fileName)
    if (!guarded.ok) {
      throw new StudioLogPersistenceError(guarded.reason)
    }
    const { logPath } = guarded
    if (!existsSync(logPath)) writeFileSync(logPath, '', 'utf8')
    const openGuard = assertKnownLogFile(logPath, guarded.allowedRoots)
    if (!openGuard.ok) {
      throw new StudioLogPersistenceError(openGuard.reason)
    }
    activeWriter = createWriteStream(logPath, { flags: 'a' })
    activeLogFile = fileName
    logBuffer.setFileWriter(activeWriter)
  })
}

function truncateGuardedStudioLogs(logsDir: string): void {
  const canonicalDir = resolve(logsDir)
  if (!existsSync(canonicalDir)) mkdirSync(canonicalDir, { recursive: true })
  const allowedRoots = [canonicalDir]
  for (const fileName of ['ollama-serve.log', 'tabby-serve.log'] as const) {
    const logPath = join(canonicalDir, fileName)
    const guard = assertKnownLogFile(logPath, allowedRoots)
    if (!guard.ok) {
      throw new StudioLogPersistenceError(guard.reason)
    }
    const truncateGuard = assertKnownLogFile(logPath, allowedRoots)
    if (!truncateGuard.ok) {
      throw new StudioLogPersistenceError(truncateGuard.reason)
    }
    writeFileSync(logPath, '', 'utf8')
  }
}

/** Atomicky vyprázdní RAM buffer a volitelně diskové logy (po potvrzení v UI). */
export async function clearStudioLogs(logsDir: string, disk: boolean): Promise<void> {
  return withMutex(async () => {
    logBuffer.clear()
    if (activeWriter) {
      activeWriter.end()
      activeWriter = null
      activeLogFile = null
      logBuffer.setFileWriter(null)
    }
    if (disk) {
      truncateGuardedStudioLogs(logsDir)
    }
  })
}

export function closeStudioLogWriter(): void {
  if (activeWriter) {
    try {
      activeWriter.end()
    } catch {
      /* ignore */
    }
    activeWriter = null
    activeLogFile = null
    logBuffer.setFileWriter(null)
  }
}

/** Test-only reset. */
export function resetStudioLogPersistenceForTests(): void {
  scrubbedDir = null
  closeStudioLogWriter()
  mutexTail = Promise.resolve()
}
