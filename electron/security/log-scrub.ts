import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { createInterface } from 'readline'
import { basename, dirname, join, resolve } from 'path'
import {
  isTabbySensitiveLabelLine,
  REDACTION_MARKER,
  sanitizeSecrets,
  sanitizeTabbyKeyLine
} from './secret-redactor'
import { sanitizePathForState, sanitizeUnknownError } from './sanitize-state'

export interface ScrubResult {
  ok: boolean
  path: string
  linesRead: number
  linesChanged: number
  error?: string
}

function toPublicScrubResult(result: ScrubResult): ScrubResult {
  return {
    ...result,
    path: sanitizePathForState(result.path),
    error: result.error ? sanitizeUnknownError(result.error) : undefined
  }
}

export interface StatefulScrubState {
  pendingSensitive: boolean
}

export function createStatefulScrubState(): StatefulScrubState {
  return { pendingSensitive: false }
}

/** Sanitizace řádku se sdíleným stavem label→secret (pro historické logy). */
export function scrubLogLineStateful(line: string, state: StatefulScrubState): string {
  if (state.pendingSensitive) {
    state.pendingSensitive = false
    const trimmed = line.trim()
    return trimmed ? REDACTION_MARKER : ''
  }
  if (isTabbySensitiveLabelLine(line)) {
    state.pendingSensitive = true
    return sanitizeTabbyKeyLine(line)
  }
  return sanitizeSecrets(sanitizeTabbyKeyLine(line))
}

/**
 * Atomicky přepíše textový log: každý řádek projde sanitizací.
 * Při chybě ponechá původní soubor nedotčený.
 */
export async function scrubLogFileAtomic(
  logPath: string,
  options?: {
    sanitize?: (line: string) => string
    allowedRoots?: string[]
  }
): Promise<ScrubResult> {
  const allowedRoots = options?.allowedRoots ?? [STUDIO_LOG_DIR, resolve(logPath, '..')]
  const guard = assertKnownLogFile(logPath, allowedRoots)
  if (!guard.ok) {
    return toPublicScrubResult({
      ok: false,
      path: logPath,
      linesRead: 0,
      linesChanged: 0,
      error: guard.reason
    })
  }

  const openGuard = assertKnownLogFile(logPath, allowedRoots)
  if (!openGuard.ok) {
    return toPublicScrubResult({
      ok: false,
      path: logPath,
      linesRead: 0,
      linesChanged: 0,
      error: openGuard.reason
    })
  }

  const result: ScrubResult = {
    ok: false,
    path: logPath,
    linesRead: 0,
    linesChanged: 0
  }
  if (!existsSync(logPath)) {
    result.ok = true
    return toPublicScrubResult(result)
  }

  const temporary = `${logPath}.scrub.tmp`
  const state = createStatefulScrubState()
  const sanitize =
    options?.sanitize ?? ((line: string) => scrubLogLineStateful(line, state))
  try {
    const input = createReadStream(logPath, { encoding: 'utf8' })
    const output = createWriteStream(temporary, { encoding: 'utf8' })
    const rl = createInterface({ input, crlfDelay: Infinity })

    for await (const line of rl) {
      result.linesRead += 1
      const cleaned = sanitize(line)
      if (cleaned !== line) result.linesChanged += 1
      output.write(`${cleaned}\n`)
    }

    await new Promise<void>((resolvePromise, reject) => {
      output.end(() => resolvePromise())
      output.on('error', reject)
    })

    const renameGuard = assertKnownLogFile(logPath, allowedRoots)
    if (!renameGuard.ok) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary)
      } catch {
        /* ignore cleanup failure */
      }
      result.error = renameGuard.reason
      return toPublicScrubResult(result)
    }
    const tempGuard = assertKnownLogFile(temporary, allowedRoots)
    if (!tempGuard.ok) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary)
      } catch {
        /* ignore cleanup failure */
      }
      result.error = tempGuard.reason
      return toPublicScrubResult(result)
    }

    renameSync(temporary, logPath)
    result.ok = true
    return toPublicScrubResult(result)
  } catch (err) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      /* ignore cleanup failure */
    }
    result.error = err instanceof Error ? err.message : String(err)
    return toPublicScrubResult(result)
  }
}

const STUDIO_LOG_DIR = resolve(process.env.APPDATA ?? '', 'OllamaStudio', 'logs')

function canonicalPath(path: string): string | null {
  try {
    if (existsSync(path)) {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        return realpathSync.native(path)
      }
    }
    return realpathSync.native(path)
  } catch {
    try {
      const dir = dirname(path)
      if (existsSync(dir)) {
        return join(realpathSync.native(dir), basename(path))
      }
      return resolve(path)
    } catch {
      return null
    }
  }
}

/** Povolí scrub jen souborů uvnitř známých log adresářů (realpath guard). */
export function assertKnownLogFile(
  logPath: string,
  allowedRoots: string[] = [STUDIO_LOG_DIR]
): { ok: true } | { ok: false; reason: string } {
  const canonical = canonicalPath(logPath)
  if (!canonical) return { ok: false, reason: 'invalid path' }
  for (const root of allowedRoots) {
    const canonicalRoot = canonicalPath(root)
    if (!canonicalRoot) continue
    const prefix = canonicalRoot.endsWith('\\') || canonicalRoot.endsWith('/')
      ? canonicalRoot
      : `${canonicalRoot}${process.platform === 'win32' ? '\\' : '/'}`
    if (canonical === canonicalRoot || canonical.startsWith(prefix)) {
      return { ok: true }
    }
  }
  return { ok: false, reason: 'path outside known log directories' }
}

export async function scrubStudioLogFiles(logsDir: string): Promise<ScrubResult[]> {
  const names = ['ollama-serve.log', 'tabby-serve.log']
  const allowedRoots = [resolve(logsDir), STUDIO_LOG_DIR]
  const results: ScrubResult[] = []
  for (const name of names) {
    const state = createStatefulScrubState()
    results.push(
      await scrubLogFileAtomic(join(logsDir, name), {
        allowedRoots,
        sanitize: (line) => scrubLogLineStateful(line, state)
      })
    )
  }
  return results
}

export interface TabbyRuntimeLogCleanupResult {
  scrubbed: ScrubResult[]
  zipFiles: string[]
  skippedZip: boolean
}

function sanitizeZipPathList(paths: string[]): string[] {
  return paths.map((p) => sanitizePathForState(p))
}

/**
 * Bezpečně scrubne textové logy v Tabby runtime složce.
 * ZIP archivy se automaticky nemažou — vrátí jejich seznam pro explicitní potvrzení.
 */
export async function scrubTabbyRuntimeTextLogs(
  installDir: string
): Promise<TabbyRuntimeLogCleanupResult> {
  const logsDir = join(installDir, 'logs')
  const scrubbed: ScrubResult[] = []
  const zipFiles: string[] = []

  if (!existsSync(logsDir)) {
    return { scrubbed, zipFiles, skippedZip: true }
  }

  const allowedRoots = [logsDir]
  for (const name of readdirSync(logsDir)) {
    const full = join(logsDir, name)
    if (name.endsWith('.zip')) {
      zipFiles.push(full)
      continue
    }
    if (name.endsWith('.log')) {
      scrubbed.push(
        await scrubLogFileAtomic(full, {
          allowedRoots: [resolve(logsDir)]
        })
      )
    }
  }

  return { scrubbed, zipFiles: sanitizeZipPathList(zipFiles), skippedZip: zipFiles.length > 0 }
}

/** Smaže explicitně potvrzené ZIP archivy v Tabby logs/ (bez rozbalení). */
export function deleteTabbyRuntimeZipLogs(
  installDir: string,
  zipPaths: string[]
): { deleted: string[]; errors: string[] } {
  const logsDir = join(installDir, 'logs')
  const allowedRoots = [logsDir]
  const deleted: string[] = []
  const errors: string[] = []
  for (const zipPath of zipPaths) {
    const guard = assertKnownLogFile(zipPath, allowedRoots)
    if (!guard.ok) {
      errors.push(`${sanitizePathForState(zipPath)}: ${guard.reason}`)
      continue
    }
    if (!zipPath.endsWith('.zip')) {
      errors.push(`${sanitizePathForState(zipPath)}: not a zip file`)
      continue
    }
    const deleteGuard = assertKnownLogFile(zipPath, allowedRoots)
    if (!deleteGuard.ok) {
      errors.push(`${sanitizePathForState(zipPath)}: ${deleteGuard.reason}`)
      continue
    }
    try {
      unlinkSync(zipPath)
      deleted.push(sanitizePathForState(zipPath))
    } catch (err) {
      errors.push(
        `${sanitizePathForState(zipPath)}: ${sanitizeUnknownError(err)}`
      )
    }
  }
  return { deleted, errors }
}

/** Vyprázdní známé Studio log soubory (po potvrzení v UI). */
export function truncateStudioLogFiles(logsDir: string): void {
  const canonicalDir = resolve(logsDir)
  if (!existsSync(canonicalDir)) mkdirSync(canonicalDir, { recursive: true })
  const allowedRoots = [canonicalDir]
  for (const name of ['ollama-serve.log', 'tabby-serve.log']) {
    const logPath = join(canonicalDir, name)
    const guard = assertKnownLogFile(logPath, allowedRoots)
    if (!guard.ok) {
      throw new Error(guard.reason)
    }
    const truncateGuard = assertKnownLogFile(logPath, allowedRoots)
    if (!truncateGuard.ok) {
      throw new Error(truncateGuard.reason)
    }
    writeFileSync(logPath, '', 'utf8')
  }
}
