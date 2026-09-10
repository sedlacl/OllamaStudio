export function previewHfFolder(repoId: string, revision: string): string {
  const id = repoId
    .trim()
    .replace(/^https?:\/\/huggingface\.co\//i, '')
    .replace(/^(models|datasets)\//i, '')
    .replace(/\/+$/, '')
  const parts = id.split('/').filter(Boolean)
  const base = parts[parts.length - 1] ?? ''
  const rev = revision.trim()
  if (!base) return ''
  if (!rev || rev.toLowerCase() === 'main') return base
  return `${base}-${rev}`
}

export function formatDownloadSize(bytes: number | null | undefined, unknownLabel = '—'): string {
  if (bytes == null) return unknownLabel
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${bytes} B`
}
