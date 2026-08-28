/** Lightweight patch gate for HF download — avoids importing serve-manager from hf-download. */

let externalProcess = false
let runtimePatchValid = false

export function setTabbyPatchReadiness(opts: {
  externalProcess: boolean
  runtimePatchValid: boolean
}): void {
  externalProcess = opts.externalProcess
  runtimePatchValid = opts.runtimePatchValid
}

export function isTabbyDownloadAllowed(): boolean {
  return runtimePatchValid && !externalProcess
}

export function resetTabbyPatchReadinessForTests(): void {
  externalProcess = false
  runtimePatchValid = true
}
