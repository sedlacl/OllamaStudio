import { createHash } from 'crypto'
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(scriptDir, '..')
const manifest = JSON.parse(
  readFileSync(join(repoDir, 'resources', 'tabby', 'patch-manifest.json'), 'utf-8')
)
const installDir = resolve(
  process.argv[2] || process.env.TABBY_INSTALL_DIR || 'D:\\AI\\Tabby'
)
const hash = (value) => createHash('sha256').update(value).digest('hex')

function knownPatchedHashes(spec) {
  return new Set([spec.patchedSha256, ...(spec.legacyPatchedSha256 ?? [])])
}

for (const spec of manifest.patches) {
  const bundledRaw = readFileSync(
    join(repoDir, 'resources', 'tabby', spec.target.split('/').pop())
  )
  const bundled = Buffer.from(bundledRaw.toString('utf-8').replace(/\r\n?/g, '\n'), 'utf-8')
  if (hash(bundled) !== spec.patchedSha256) {
    throw new Error(`Bundled ${spec.target} hash does not match patch-manifest.json`)
  }

  const target = join(installDir, ...String(spec.target).split('/'))
  if (!existsSync(target)) {
    throw new Error(`Tabby patch target was not found: ${spec.target}`)
  }

  const actual = hash(readFileSync(target))
  if (knownPatchedHashes(spec).has(actual)) {
    console.log(`Tabby patch ${manifest.version} ${spec.target}: already applied`)
    continue
  }
  if (actual !== spec.originalSha256) {
    throw new Error(
      `Tabby patch ${manifest.version} ${spec.target}: unsupported source hash ${actual}`
    )
  }

  const temporary = `${target}.${manifest.version}.tmp`
  const backup = `${target}.${manifest.version}.bak`
  let movedOriginal = false
  try {
    if (existsSync(temporary)) unlinkSync(temporary)
    if (existsSync(backup)) unlinkSync(backup)
    writeFileSync(temporary, bundled)
    renameSync(target, backup)
    movedOriginal = true
    renameSync(temporary, target)
    console.log(`Tabby patch ${manifest.version} ${spec.target}: applied`)
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
      if (movedOriginal && !existsSync(target) && existsSync(backup)) {
        renameSync(backup, target)
      }
    } catch {
      /* Preserve the original installation error. */
    }
    throw error
  }
}
