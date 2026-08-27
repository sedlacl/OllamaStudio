/**
 * Smoke: Tabby log parser + LogBuffer vendor mode.
 * Run: npx tsx scripts/smoke-tabby-logs.mts
 */
import { LogBuffer } from '../electron/ollama/log-buffer.ts'
import { parseTabbyLogLine } from '../electron/tabby/log-parser.ts'

let failed = 0
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++
    console.error('FAIL:', msg)
  } else {
    console.log('ok  ', msg)
  }
}

const metrics = parseTabbyLogLine(
  'Metrics (ID: cafe0123): 8 tokens generated in 0.5 seconds · Generate: 16.0 T/s'
)
assert(metrics.requestId === 'cafe0123', 'metrics request id')
assert(metrics.generationTokens === 8, 'metrics tokens')
assert(metrics.generationTokensPerSec === 16, 'metrics tps')

const buf = new LogBuffer()
buf.setVendor('tabby')
buf.append('stdout', 'Received chat completion request cafe0123')
buf.append(
  'stdout',
  'Metrics (ID: cafe0123): 8 tokens generated in 0.5 seconds · Generate: 16.0 T/s'
)
assert(buf.getRollingTokensPerSec() === 16, 'rolling tps from Tabby metrics')
assert(buf.getRequestHistory().length >= 0, 'history accessible')

if (failed > 0) {
  console.error(`\n${failed} failure(s)`)
  process.exit(1)
}
console.log('\nAll Tabby smoke checks passed.')
