import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import {
  HfApiError,
  hfApiRepoPath,
  hfErrorCodeFromStatus,
  parseHfRefsResponse,
  parseHfTreeSize,
  sumHfSiblingSizes,
  sumHfTreeSizes,
  type HfRevision
} from './hf-download-helpers'

const HF_ORIGIN = 'https://huggingface.co'
const USER_AGENT = 'OllamaStudio'
const REFS_TIMEOUT_MS = 20_000
const SIZE_TIMEOUT_MS = 20_000

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function hfFetchJson(
  url: string,
  token: string | undefined,
  timeoutMs: number
): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch {
    throw new HfApiError('network')
  }
  if (!res.ok) {
    throw new HfApiError(hfErrorCodeFromStatus(res.status), res.status)
  }
  try {
    return await res.json()
  } catch {
    throw new HfApiError('invalid_json', res.status)
  }
}

function revisionOrMain(revision?: string): string {
  const rev = revision?.trim()
  return rev || 'main'
}

export async function fetchHfRevisions(
  repoId: string,
  token?: string
): Promise<HfRevision[]> {
  const repoPath = hfApiRepoPath(repoId)
  if (!repoPath) throw new HfApiError('not_found')
  const data = await hfFetchJson(
    `${HF_ORIGIN}/api/models/${repoPath}/refs`,
    token,
    REFS_TIMEOUT_MS
  )
  return parseHfRefsResponse(data)
}

export async function fetchHfExpectedBytes(
  repoId: string,
  revision: string | undefined,
  token?: string
): Promise<number | null> {
  const repoPath = hfApiRepoPath(repoId)
  if (!repoPath) return null
  const rev = encodeURIComponent(revisionOrMain(revision))

  try {
    const data = await hfFetchJson(
      `${HF_ORIGIN}/api/models/${repoPath}/treesize/${rev}`,
      token,
      SIZE_TIMEOUT_MS
    )
    const size = parseHfTreeSize(data)
    if (size != null) return size
  } catch {
    /* fallback */
  }

  try {
    const data = await hfFetchJson(
      `${HF_ORIGIN}/api/models/${repoPath}/revision/${rev}?blobs=true`,
      token,
      SIZE_TIMEOUT_MS
    )
    const size = sumHfSiblingSizes(data)
    if (size != null) return size
  } catch {
    /* fallback */
  }

  try {
    const data = await hfFetchJson(
      `${HF_ORIGIN}/api/models/${repoPath}/tree/${rev}?recursive=true`,
      token,
      SIZE_TIMEOUT_MS
    )
    return sumHfTreeSizes(data)
  } catch {
    return null
  }
}

/** Rekurzivní součet souborů včetně .incomplete / temp (Windows-safe). */
export async function directoryByteSize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      try {
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        const info = await stat(full)
        if (info.isFile()) total += info.size
      } catch {
        /* zamčený / zmizelý soubor na Windows */
      }
    }
  }

  await walk(dir)
  return total
}
