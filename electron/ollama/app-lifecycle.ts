/** App-wide quitting flag so IPC polls can go quiet before backends die. */

let quitting = false

export function markAppQuitting(): void {
  quitting = true
}

export function isAppQuitting(): boolean {
  return quitting
}

/** Test-only — do not call from production code. */
export function resetAppQuittingForTests(): void {
  quitting = false
}
