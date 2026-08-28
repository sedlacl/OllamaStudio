/** In-flight HF download tracked so a dying Tabby can fail the UI instead of going silent. */

export interface DownloadSession {
  operationId: string
  folderName: string
  bytesDownloaded: number
  bytesTotal: number | null
}

let session: DownloadSession | null = null
let interruptedByBackend = false

export function startDownloadSession(next: DownloadSession): void {
  session = { ...next }
  interruptedByBackend = false
}

export function updateDownloadSession(partial: Partial<Omit<DownloadSession, 'operationId'>>): void {
  if (!session) return
  session = { ...session, ...partial }
}

export function finishDownloadSession(): DownloadSession | null {
  const prev = session
  session = null
  interruptedByBackend = false
  return prev
}

export function getDownloadSession(): DownloadSession | null {
  return session
}

/** @returns true when a download was in flight and is now marked interrupted. */
export function noteBackendLost(): boolean {
  if (!session) return false
  interruptedByBackend = true
  return true
}

export function wasDownloadInterruptedByBackend(): boolean {
  return interruptedByBackend
}

/** Test-only. */
export function resetDownloadSessionForTests(): void {
  session = null
  interruptedByBackend = false
}
