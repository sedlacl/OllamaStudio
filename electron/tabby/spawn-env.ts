/** Env a argumenty pro spawn TabbyAPI z Electronu — bez bufferování a bez Node/Electron flagů. */

/**
 * Rich konzole Tabby zalamuje na šířku terminálu a do pipe posílá tvrdé
 * newliny, takže `Metrics (ID: …)` doteče rozsekaná na několik řádků.
 * Široká konzole drží jeden logický řádek pohromadě (parser umí i zalomené).
 */
const LOG_CONSOLE_WIDTH = '400'

export function buildTabbySpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.PYTHONUNBUFFERED = '1'
  env.PYTHONUTF8 = '1'
  env.PYTHONIOENCODING = 'utf-8'
  if (!env.TABBY_LOG_CONSOLE_WIDTH?.trim()) {
    env.TABBY_LOG_CONSOLE_WIDTH = LOG_CONSOLE_WIDTH
  }
  return env
}

export function tabbySpawnArgs(mainPy: string): string[] {
  return ['-u', mainPy]
}
