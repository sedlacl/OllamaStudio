import { createWriteStream, existsSync, mkdirSync, writeFileSync, type WriteStream } from 'fs'
import { join, resolve } from 'path'
import { logBuffer } from '../ollama/log-buffer'
import { scrubStudioLogFiles, truncateStudioLogFiles } from './log-scrub'

export type StudioLogFileName = 'ollama-serve.log' | 'tabby-serve.log'

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

async function scrubOnce(logsDir: string): Promise<void> {
  const resolved = resolve(logsDir)
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true })
  if (scrubbedDir === resolved) return
  await scrubStudioLogFiles(resolved)
  scrubbedDir = resolved
}

/**
 * Jednorázový scrub historických Studio logů — volat až po registraci známých auth secretů.
 * Žádný writer se neotevře dřív než dokončí scrub.
 */
export function prepareStudioLogScrub(logsDir: string): Promise<void> {
  return withMutex(() => scrubOnce(logsDir))
}

/** Otevře append writer pro aktivní backend — až po dokončeném scrubu. */
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
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
    const logPath = join(resolve(logsDir), fileName)
    if (!existsSync(logPath)) writeFileSync(logPath, '', 'utf8')
    activeWriter = createWriteStream(logPath, { flags: 'a' })
    activeLogFile = fileName
    logBuffer.setFileWriter(activeWriter)
  })
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
      truncateStudioLogFiles(logsDir)
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