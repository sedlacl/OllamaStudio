import { app } from 'electron'

/** Opt-in dev CDP port — set via env; never enabled in packaged builds. */
export const REMOTE_DEBUG_ENV = 'OLLAMA_STUDIO_REMOTE_DEBUG_PORT'

const MIN_PORT = 1024
const MAX_PORT = 65535

export function parseRemoteDebugPort(raw: string | undefined): number | null {
  if (!raw?.trim()) return null
  const port = Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null
  return port
}

export function isRemoteDebugAllowed(
  nodeEnv: string | undefined,
  isPackaged: boolean
): boolean {
  if (isPackaged) return false
  return nodeEnv === 'development'
}

export function resolveRemoteDebugPort(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean
): number | null {
  if (!isRemoteDebugAllowed(env.NODE_ENV, isPackaged)) return null
  return parseRemoteDebugPort(env[REMOTE_DEBUG_ENV])
}

/** Call before `app.whenReady()` — opens CDP only in dev when env port is set. */
export function applyRemoteDebugPortIfEnabled(): number | null {
  const port = resolveRemoteDebugPort(process.env, app.isPackaged)
  if (port == null) return null
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  app.commandLine.appendSwitch('remote-debugging-port', String(port))
  console.log(`[dev] remote debugging enabled on 127.0.0.1:${port}`)
  return port
}
