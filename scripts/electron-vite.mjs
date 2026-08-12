/**
 * Cursor (a další nástroje) často nastaví NODE_OPTIONS=--use-system-ca.
 * Electron tento flag v NODE_OPTIONS odmítá → start selže.
 * Před spuštěním electron-vite flag odfiltrujeme; zbytek NODE_OPTIONS necháme.
 */
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function sanitizeNodeOptions(raw) {
  if (!raw) return raw
  const cleaned = raw
    .split(/\s+/)
    .filter((flag) => flag && flag !== '--use-system-ca')
    .join(' ')
    .trim()
  return cleaned.length > 0 ? cleaned : undefined
}

const next = sanitizeNodeOptions(process.env.NODE_OPTIONS)
if (next === undefined) {
  delete process.env.NODE_OPTIONS
} else {
  process.env.NODE_OPTIONS = next
}

const electronViteBin = join(
  dirname(require.resolve('electron-vite/package.json')),
  'bin',
  'electron-vite.js'
)

const args = process.argv.slice(2)
const child = spawn(process.execPath, [electronViteBin, ...args], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: false
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
