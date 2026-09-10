/** Převod naměřené RAM/VRAM procesu na Ollama-style size / size_vram (bajty). */

export function ollamaSizeFromProcessSplit(
  ramBytes: number,
  vramBytes: number
): { size: number; sizeVram: number } {
  const ram = Number.isFinite(ramBytes) && ramBytes > 0 ? Math.round(ramBytes) : 0
  const vram = Number.isFinite(vramBytes) && vramBytes > 0 ? Math.round(vramBytes) : 0
  return { size: ram + vram, sizeVram: vram }
}

/**
 * Split podle logu loaderu: u GPU-only loadu nejsou váhy v RAM, takže
 * working set procesu (CUDA host alokace, pinned buffery, Python) do `size`
 * nepatří — sečtený s VRAM z něj dělal falešný CPU offload.
 * Bez potvrzení z logu se vrací naměřený součet, ne dohad.
 */
export function ollamaSizeFromLoadFacts(
  ramBytes: number,
  vramBytes: number,
  gpuOnly: boolean
): { size: number; sizeVram: number } {
  const measured = ollamaSizeFromProcessSplit(ramBytes, vramBytes)
  if (!gpuOnly || measured.sizeVram === 0) return measured
  return { size: measured.sizeVram, sizeVram: measured.sizeVram }
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
