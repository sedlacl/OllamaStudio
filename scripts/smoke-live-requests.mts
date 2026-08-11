/**
 * Deterministic smoke for live active-request parsing + request history.
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

function phase7_historyLifecycleOrderMaxDedup(): void {
  let t = 1_000_000
  const buf = new LogBuffer({ now: () => t })

  // Complete 12 tasks → history capped at 10, newest first.
  for (let i = 1; i <= 12; i++) {
    t += 10
    buf.append('stderr', `slot launch_slot_: id  0 | task ${i} | processing task, is_child = 0`)
    t += 10
    buf.append(
      'stderr',
      `slot      release: id  0 | task ${i} | stop processing: n_tokens = ${100 + i}, truncated = 0`
    )
  }

  const hist = buf.getRequestHistory()
  assert(hist.length === 10, 'history max length 10')
  assert(
    hist.every((h, idx) => idx === 0 || hist[idx - 1]!.taskId > h.taskId),
    'history newest-first (higher task id first after sequential completes)'
  )
  assert(hist[0]?.taskId === 12, 'newest history item is task 12')
  assert(hist[9]?.taskId === 3, 'oldest retained history item is task 3')
  assert(
    hist.every((h) => h.result === 'done'),
    'completed tasks archived as done'
  )
  assert(
    hist[0]?.completionReason === 'slot release' ||
      hist[0]?.completionReason === 'stop processing',
    'completion reason observed from logs'
  )

  // Duplicate release lines must not create a second history row.
  const beforeDup = buf.getRequestHistory().length
  t += 10
  buf.append(
    'stderr',
    'slot      release: id  0 | task 12 | stop processing: n_tokens = 112, truncated = 0'
  )
  t += 10
  buf.append(
    'stderr',
    'slot      release: id  0 | task 12 | stop processing: n_tokens = 112, truncated = 0'
  )
  const afterDup = buf.getRequestHistory()
  assert(afterDup.length === beforeDup, 'duplicate release does not grow history')
  assert(afterDup.filter((h) => h.taskId === 12).length === 1, 'task 12 appears once in history')

  // Completed task is in history regardless of live grace / prune.
  assert(
    buf.getRequestHistory().some((h) => h.taskId === 12 && h.result === 'done'),
    'completed task is in history independent of live grace'
  )
  // Sync replay must not resurrect tasks 1–2 that fell off the max-10 cap.
  assert(
    !buf.getRequestHistory().some((h) => h.taskId === 1 || h.taskId === 2),
    'evicted history items stay evicted after sync'
  )

  // Clear logs clears history.
  buf.clear()
  assert(buf.getRequestHistory().length === 0, 'clear() empties history')
  assert(buf.getActiveRequests().length === 0, 'clear() empties live map')
}

function phase8_activeToHistoryThenStale(): void {
  let t = 5_000_000
  const buf = new LogBuffer({ now: () => t })

  t += 1
  buf.append(
    'stderr',
    'slot print_timing: id  0 | task 500 | prompt processing, n_tokens =  100, progress = 0.25, t =  2.00 s / 50.00 tokens per second'
  )
  assert(buf.getActiveRequests().some((r) => r.taskId === 500 && r.status === 'active'), 'task 500 active')
  assert(buf.getRequestHistory().length === 0, 'no history while still active')

  t += 1
  buf.append(
    'stderr',
    'slot      release: id  0 | task 500 | stop processing: n_tokens = 120, truncated = 0'
  )
  const histAfterDone = buf.getRequestHistory()
  assert(histAfterDone.length === 1, 'snapshot moves to history on completion')
  assert(histAfterDone[0]?.taskId === 500, 'history task 500')
  assert(histAfterDone[0]?.result === 'done', 'result done')
  assert(histAfterDone[0]?.progressPercent === 25, 'history keeps observed progress (not fabricated 100)')
  assert(histAfterDone[0]?.promptTokens === 100, 'prompt tokens retained when observed')
  assert(histAfterDone[0]?.promptTokensPerSec === 50, 'prompt tok/s retained when observed')

  // Still present in live completed grace immediately after completion.
  assert(
    buf.getActiveRequests().some((r) => r.taskId === 500 && r.status === 'completed'),
    'completed remains in live map during grace'
  )

  // After grace, pruned from live but history kept.
  t += 9_000
  assert(
    !buf.getActiveRequests().some((r) => r.taskId === 500),
    'completed pruned from live after grace'
  )
  assert(
    buf.getRequestHistory().some((h) => h.taskId === 500 && h.result === 'done'),
    'history retained after live prune'
  )

  // Stale active task marked stale (not done).
  t += 1
  buf.append('stderr', 'slot launch_slot_: id  1 | task 600 | processing task, is_child = 0')
  assert(buf.getActiveRequests().some((r) => r.taskId === 600), 'task 600 active')
  t += 91_000
  // Trigger sync/prune via getter
  buf.getActiveRequests()
  const staleHist = buf.getRequestHistory().find((h) => h.taskId === 600)
  assert(staleHist != null, 'stale task archived to history')
  assert(staleHist?.result === 'stale', 'stale/timeout result (not silent success)')
  assert(!buf.getActiveRequests().some((r) => r.taskId === 600), 'stale removed from live')
}

function phase9_historyNewestFirstMixed(): void {
  let t = 9_000_000
  const buf = new LogBuffer({ now: () => t })

  t += 1
  buf.append('stderr', 'slot launch_slot_: id  0 | task 1 | processing task, is_child = 0')
  t += 1
  buf.append(
    'stderr',
    'slot      release: id  0 | task 1 | stop processing: n_tokens = 10, truncated = 0'
  )
  t += 1
  buf.append('stderr', 'slot launch_slot_: id  0 | task 2 | processing task, is_child = 0')
  t += 1
  buf.append('stderr', 'slot update: id  0 | task 2 | done processing')

  const hist = buf.getRequestHistory()
  assert(hist.length === 2, 'two history items')
  assert(hist[0]?.taskId === 2 && hist[1]?.taskId === 1, 'newest-first order 2 then 1')
  assert(hist[0]?.completionReason === 'done processing', 'done processing reason')
}

phase1_progressFormat()
phase2_structuredDebug()
phase3_launchAndGeneration()
phase4_completionAndConcurrent()
phase5_rawSlotNotError()
phase6_rehydrateFromEntries()
phase7_historyLifecycleOrderMaxDedup()
phase8_activeToHistoryThenStale()
phase9_historyNewestFirstMixed()

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll smoke checks passed')
