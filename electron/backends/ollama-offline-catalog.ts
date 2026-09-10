import { lstat, readFile, readdir, realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, relative, resolve, sep } from 'path'
import type { CatalogModel } from '../../shared/backend-contract'

const MAX_JSON_BYTES = 10 * 1024 * 1024

interface ManifestDescriptor {
  digest?: unknown
  size?: unknown
  mediaType?: unknown
}

interface OllamaManifest {
  config?: ManifestDescriptor
  layers?: ManifestDescriptor[]
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

async function readSmallJson(path: string): Promise<unknown> {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_JSON_BYTES) {
    throw new Error('Offline catalog JSON is not a bounded regular file')
  }
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function existingRealDirectory(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory()) return null
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function digestBlobName(digest: unknown): string | null {
  if (typeof digest !== 'string') return null
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest)
  return match ? `sha256-${match[1].toLowerCase()}` : null
}

function modelIdFromManifest(parts: string[]): string | null {
  if (parts.length < 4 || parts.some((part) => !part || part === '.' || part === '..')) {
    return null
  }
  const [host, ...rest] = parts
  const tag = rest.pop()!
  const model = rest.pop()!
  const namespace = rest
  const prefix =
    host === 'registry.ollama.ai'
      ? namespace.join('/')
      : [host, ...namespace].join('/')
  const normalizedPrefix = prefix === 'library' ? '' : prefix
  return `${normalizedPrefix ? `${normalizedPrefix}/` : ''}${model}:${tag}`
}

function manifestSize(layers: ManifestDescriptor[]): number | null {
  let total = 0
  for (const layer of layers) {
    const value = layer?.size
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      !Number.isSafeInteger(total + value)
    ) {
      return null
    }
    total += value
  }
  return total
}

function metadataFromConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const metadata: Record<string, unknown> = {}
  for (const key of ['architecture', 'model_type', 'parameter_count', 'quantization_version']) {
    const candidate = source[key]
    if (
      typeof candidate === 'string' ||
      (typeof candidate === 'number' && Number.isFinite(candidate))
    ) {
      metadata[key] = candidate
    }
  }
  return metadata
}

async function readConfigMetadata(
  blobsRoot: string,
  descriptor: ManifestDescriptor | undefined
): Promise<Record<string, unknown>> {
  const blobName = digestBlobName(descriptor?.digest)
  if (!blobName) return {}
  const candidate = resolve(blobsRoot, blobName)
  if (!isInside(blobsRoot, candidate)) return {}
  try {
    const info = await lstat(candidate)
    if (!info.isFile() || info.isSymbolicLink()) return {}
    const canonical = await realpath(candidate)
    if (!isInside(blobsRoot, canonical)) return {}
    return metadataFromConfig(await readSmallJson(canonical))
  } catch {
    return {}
  }
}

export function resolveOllamaModelsRoot(configured: string): string {
  const trimmed = configured.trim()
  return trimmed ? resolve(trimmed) : resolve(homedir(), '.ollama', 'models')
}

export async function discoverOllamaModels(rootPath: string): Promise<CatalogModel[]> {
  const root = await existingRealDirectory(rootPath)
  if (!root) return []
  const manifestsRoot = await existingRealDirectory(resolve(root, 'manifests'))
  const blobsRoot = await existingRealDirectory(resolve(root, 'blobs'))
  if (!manifestsRoot || !isInside(root, manifestsRoot)) return []

  const models: CatalogModel[] = []
  const walk = async (current: string, parts: string[]): Promise<void> => {
    if (current !== manifestsRoot && !isInside(manifestsRoot, current)) return
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.name || entry.name === '.' || entry.name === '..' || /[/\\]/.test(entry.name)) {
        continue
      }
      const candidate = resolve(current, entry.name)
      if (!isInside(manifestsRoot, candidate)) continue
      let info
      try {
        info = await lstat(candidate)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        await walk(candidate, [...parts, entry.name]).catch(() => {})
        continue
      }
      if (!info.isFile()) continue
      const id = modelIdFromManifest([...parts, entry.name])
      if (!id) continue
      try {
        const canonical = await realpath(candidate)
        if (!isInside(manifestsRoot, canonical)) continue
        const raw = await readSmallJson(canonical)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const manifest = raw as OllamaManifest
        const layers = Array.isArray(manifest.layers) ? manifest.layers : []
        const metadata =
          blobsRoot && isInside(root, blobsRoot)
            ? await readConfigMetadata(blobsRoot, manifest.config)
            : {}
        models.push({
          providerId: 'ollama',
          modelId: id,
          displayName: id,
          sizeBytes: manifestSize(layers),
          metadata: {
            ...metadata,
            digest: typeof manifest.config?.digest === 'string' ? manifest.config.digest : undefined,
            layerCount: layers.length
          }
        })
      } catch {
        // Jedna poškozená nebo během skenu změněná manifest cesta nesmí skrýt ostatní.
      }
    }
  }

  await walk(manifestsRoot, [])
  return models.sort((left, right) => left.modelId.localeCompare(right.modelId))
}
