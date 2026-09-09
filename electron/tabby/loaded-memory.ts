/** Převod naměřené RAM/VRAM procesu na Ollama-style size / size_vram (bajty). */

export function ollamaSizeFromProcessSplit(
  ramBytes: number,
  vramBytes: number
): { size: number; sizeVram: number } {
  const ram = Number.isFinite(ramBytes) && ramBytes > 0 ? Math.round(ramBytes) : 0
  const vram = Number.isFinite(vramBytes) && vramBytes > 0 ? Math.round(vramBytes) : 0
  return { size: ram + vram, sizeVram: vram }
}

export function vramMbForPids(
  rows: Array<{ pid: number; gpuMemoryMb: number | null }>,
  pids: number[]
): number {
  const want = new Set(pids)
  let mb = 0
  for (const row of rows) {
    if (!want.has(row.pid) || row.gpuMemoryMb == null || !(row.gpuMemoryMb > 0)) continue
    mb += row.gpuMemoryMb
  }
  return mb
}
