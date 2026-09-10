import { lstat, readdir, realpath } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'
import type { CatalogModel } from '../../shared/backend-contract'
import { inspectLocalModel } from '../tabby/local-model-info'

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export async function discoverTabbyModels(modelDir: string): Promise<CatalogModel[]> {
  let root: string
  try {
    const rootInfo = await lstat(modelDir)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return []
    root = await realpath(modelDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const entries = await readdir(root, { withFileTypes: true })
  const models: CatalogModel[] = []
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !entry.name ||
      entry.name === '.' ||
      entry.name === '..' ||
      entry.name.includes('..') ||
      /[/\\]/.test(entry.name)
    ) {
      continue
    }
    const candidate = resolve(root, entry.name)
    if (!isInside(root, candidate)) continue
    const info = await lstat(candidate)
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    const canonical = await realpath(candidate)
    if (!isInside(root, canonical)) continue
    const local = await inspectLocalModel(root, entry.name)
    models.push({
      providerId: 'tabby',
      modelId: entry.name,
      displayName: entry.name,
      sizeBytes: local.sizeState === 'known' ? local.sizeBytes : null,
      metadata: {
        completeness: local.completeness,
        sizeState: local.sizeState
      }
    })
  }
  return models.sort((left, right) => left.modelId.localeCompare(right.modelId))
}
