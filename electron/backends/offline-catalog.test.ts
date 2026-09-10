import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverOllamaModels } from './ollama-offline-catalog'
import { discoverTabbyModels } from './tabby-offline-catalog'

const roots: string[] = []

function tempRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `ollamastudio-${name}-`))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('offline provider discovery', () => {
  it('reads Ollama manifests and bounded config metadata without a runtime', async () => {
    const root = tempRoot('ollama')
    const manifestDir = join(
      root,
      'manifests',
      'registry.ollama.ai',
      'library',
      'qwen2.5'
    )
    const blobs = join(root, 'blobs')
    mkdirSync(manifestDir, { recursive: true })
    mkdirSync(blobs)
    const digest = `sha256:${'a'.repeat(64)}`
    writeFileSync(
      join(manifestDir, 'latest'),
      JSON.stringify({
        config: { digest },
        layers: [{ size: 10 }, { size: 25 }]
      })
    )
    writeFileSync(join(manifestDir, 'broken'), '{not-json')
    writeFileSync(
      join(blobs, `sha256-${'a'.repeat(64)}`),
      JSON.stringify({ architecture: 'qwen2', model_type: 'qwen2' })
    )

    await expect(discoverOllamaModels(root)).resolves.toEqual([
      expect.objectContaining({
        providerId: 'ollama',
        modelId: 'qwen2.5:latest',
        sizeBytes: 35,
        metadata: expect.objectContaining({ architecture: 'qwen2', layerCount: 2 })
      })
    ])
  })

  it('ignores manifest directory links escaping the Ollama store', async () => {
    const root = tempRoot('ollama-link')
    const manifests = join(root, 'manifests')
    const outside = tempRoot('outside')
    mkdirSync(join(root, 'blobs'), { recursive: true })
    mkdirSync(join(outside, 'library', 'escaped'), { recursive: true })
    writeFileSync(
      join(outside, 'library', 'escaped', 'latest'),
      JSON.stringify({ layers: [{ size: 999 }] })
    )
    mkdirSync(manifests, { recursive: true })
    symlinkSync(outside, join(manifests, 'registry.ollama.ai'), 'junction')

    await expect(discoverOllamaModels(root)).resolves.toEqual([])
  })

  it('scans only direct, non-linked Tabby model folders', async () => {
    const root = tempRoot('tabby')
    const model = join(root, 'safe-model')
    const outside = tempRoot('tabby-outside')
    mkdirSync(model, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(model, 'config.json'), '{}')
    writeFileSync(join(model, 'weights.safetensors'), Buffer.alloc(4))
    writeFileSync(join(outside, 'config.json'), '{}')
    symlinkSync(outside, join(root, 'escaped-model'), 'junction')

    const models = await discoverTabbyModels(root)
    expect(models).toHaveLength(1)
    expect(models[0]).toEqual(
      expect.objectContaining({
        providerId: 'tabby',
        modelId: 'safe-model',
        metadata: expect.objectContaining({ completeness: 'incomplete' })
      })
    )
  })
})
