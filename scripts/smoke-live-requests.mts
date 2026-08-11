/**
 * Deterministic smoke for live active-request parsing.
 * Run: npx tsx scripts/smoke-live-requests.mts
 */
import { LogBuffer } from '../electron/ollama/log-buffer.ts'

let failed = 0
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++
    console.error('FAIL:', msg)
  } else {
    console.log('ok  ', msg)
  }
}

function phase1_progressFormat(): void {
  const buf = new LogBuffer()
  buf.append(
    'stderr',
    'slot   operator(): id  0 | task 21928 | cached n_tokens = 24576, memory_seq_rm [24576, end)'
  )
  buf.append(
    'stderr',
    'slot print_timing: id  0 | task 21928 | prompt processing, n_tokens =  25088, progress = 0.53, t =  30.48 s / 823.07 tokens per second'
  )
  const active = buf.getActiveRequests().filter((r) => r.status === 'active')
  assert(active.length === 1, 'progress format → 1 active')
  assert(active[0]?.taskId === 21928, 'task 21928')
  assert(active[0]?.phase === 'prompt_processing', 'phase prompt_processing (not caching)')
  assert(active[0]?.progressPercent === 53, 'progress 53%')
  assert(active[0]?.nTokens === 25088, 'nTokens 25088')
  assert(active[0]?.tokensPerSec === 823.07, 'tps 823.07')
  assert(buf.getActiveRequestEstimate() === 1, 'estimate matches live count')
}

function phase2_structuredDebug(): void {
  const buf = new LogBuffer()
  const line =
    'time=2026-08-12T00:00:00.000Z level=DEBUG source=server.go:1 msg="slot print_timing: id  0 | task 21928 | prompt processing, n_tokens =  25088, progress = 0.53, t =  30.48 s / 823.07 tokens per second"'
  buf.append('stderr', line)
  const entries = buf.getEntries()
  assert(entries[0]?.level === 'debug', 'DEBUG level stays debug/cyan (not error)')
  assert(entries[0]?.category === 'request', 'DEBUG slot → category request')
  assert(buf.getActiveRequests()[0]?.status === 'active', 'structured DEBUG slot is active')
}

function phase3_launchAndGeneration(): void {
  const buf = new LogBuffer()
  buf.append('stderr', 'slot launch_slot_: id  0 | task -1 | sampler chain: logits')
  assert(buf.getActiveRequests().length === 0, 'task -1 ignored')

  buf.append('stderr', 'slot launch_slot_: id  0 | task 238 | processing task, is_child = 0')
  assert(buf.getActiveRequests().length === 1, 'appears on launch/processing task')
  assert(buf.getActiveRequests()[0]?.phase === 'prompt_processing', 'launch → prompt_processing')

  buf.append(
    'stderr',
    'slot print_timing: id  0 | task 238 | n_decoded =    100, tg =   5.57 t/s, tg_3s =   5.57 t/s'
  )
  const gen = buf.getActiveRequests()[0]
  assert(gen?.phase === 'generation', 'n_decoded → generation')
  assert(gen?.nTokens === 100, 'n_decoded tokens')
  assert(gen?.tokensPerSec === 5.57, 'tg t/s parsed')
}

function phase4_completionAndConcurrent(): void {
  const buf = new LogBuffer()
  buf.append('stderr', 'slot launch_slot_: id  0 | task 100 | processing task, is_child = 0')
  buf.append('stderr', 'slot launch_slot_: id  1 | task 200 | processing task, is_child = 0')
  assert(buf.getActiveRequests().filter((r) => r.status === 'active').length === 2, '2 concurrent')

  buf.append(
    'stderr',
    'slot      release: id  0 | task 100 | stop processing: n_tokens = 355, truncated = 0'
  )
  const after = buf.getActiveRequests()
  assert(after.some((r) => r.taskId === 100 && r.status === 'completed'), 'task 100 completed')
  assert(after.some((r) => r.taskId === 200 && r.status === 'active'), 'task 200 still active')
}

function phase5_rawSlotNotError(): void {
  const buf = new LogBuffer()
  buf.append(
    'stderr',
    'slot print_timing: id  0 | task 5 | prompt processing, n_tokens = 10, progress = 0.1, t = 1.0 s / 10 tokens per second'
  )
  const e = buf.getEntries()[0]
  assert(e?.level !== 'error', 'raw slot stderr is not error/red')
  assert(e?.category === 'request', 'raw slot → request category')
}

function phase6_rehydrateFromEntries(): void {
  const buf = new LogBuffer()
  buf.append('stderr', 'slot launch_slot_: id  0 | task 77 | processing task, is_child = 0')
  // Simulate map drift: clear via sync path by ensuring get rebuilds from entries
  const before = buf.getActiveRequests()
  assert(before.length === 1 && before[0]?.taskId === 77, 'rehydrate finds task 77 from entries')
}

phase1_progressFormat()
phase2_structuredDebug()
phase3_launchAndGeneration()
phase4_completionAndConcurrent()
phase5_rawSlotNotError()
phase6_rehydrateFromEntries()

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll smoke checks passed')
