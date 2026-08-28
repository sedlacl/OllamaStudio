import { tMain } from '../i18n'
import { isAppQuitting } from './app-lifecycle'
import {
  ErrorLogDeduper,
  formatFetchErrorUserText,
  inspectFetchError,
  shouldSkipBackendPoll,
  shouldSwallowPollError,
  stripUrlSecrets
} from './fetch-error'
import { logBuffer } from './log-buffer'

const deduper = new ErrorLogDeduper()

export function isQuietBackendPoll(serveStatus: string): boolean {
  return shouldSkipBackendPoll(isAppQuitting(), serveStatus)
}

export function shouldIgnorePollFailure(serveStatus: string): boolean {
  return shouldSwallowPollError(isAppQuitting(), serveStatus)
}

export function logIpcError(operation: string, err: unknown, fallbackUrl?: string): void {
  if (isAppQuitting()) return
  const info = inspectFetchError(err, fallbackUrl)
  const decision = deduper.record(`${operation}|${info.dedupeKey}`)
  if (!decision.shouldLog) return
  const repeat =
    decision.suppressedCount > 0
      ? tMain('errors.ipcRepeat', { count: decision.suppressedCount + 1 })
      : ''
  logBuffer.appendApp('error', `[studio] ${operation}${repeat}: ${info.logLine}`)
}

export function logAndFormatIpcError(
  operation: string,
  err: unknown,
  fallbackUrl?: string
): string {
  logIpcError(operation, err, fallbackUrl)
  return formatFetchErrorUserText(inspectFetchError(err, fallbackUrl), tMain)
}

export function serializeIpcError(
  operation: string,
  err: unknown,
  fallbackUrl?: string
): Error {
  return new Error(logAndFormatIpcError(operation, err, fallbackUrl))
}

export function safeErrorText(err: unknown): string {
  return stripUrlSecrets(err instanceof Error ? err.message : String(err))
}
