/** Env a argumenty pro spawn TabbyAPI z Electronu — bez bufferování a bez Node/Electron flagů. */

export function buildTabbySpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.PYTHONUNBUFFERED = '1'
  env.PYTHONUTF8 = '1'
  env.PYTHONIOENCODING = 'utf-8'
  return env
}

export function tabbySpawnArgs(mainPy: string): string[] {
  return ['-u', mainPy]
}
