import { readFileSync } from 'fs'
import { resolve } from 'path'
import { isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import { modelRefKey, type BackendId } from '../../shared/backend-contract'
import MissingProviderSlot from './MissingProviderSlot'
import { renderProviderSlot } from './BackendProviderContext'
import {
  assertRendererRegistryMatches,
  getRendererProvider,
  listRendererProviderIds,
  RENDERER_PROVIDERS,
  resolveRendererProviders
} from './registry'
import {
  OPTIONAL_RENDERER_SLOTS,
  REQUIRED_RENDERER_SLOTS,
  type RendererProviderDefinition
} from './types'

describe('renderer provider registry', () => {
  it('covers every BackendId with required slots', () => {
    const ids = listRendererProviderIds()
    expect(ids).toContain('ollama')
    expect(ids).toContain('tabby')
    for (const id of ids) {
      const def = getRendererProvider(id as BackendId)
      expect(def.SettingsEditor).toBeTypeOf('function')
      expect(def.ModelProfileEditor).toBeTypeOf('function')
      expect(def.AcquisitionPanel).toBeTypeOf('function')
      expect(def.id).toBe(def.descriptorId)
    }
  })

  it('fail-fast when main descriptor lacks renderer adapter', () => {
    const fakeId = 'fake' as BackendId
    expect(() =>
      assertRendererRegistryMatches([{ id: 'ollama' }, { id: 'tabby' }, { id: fakeId }])
    ).toThrow(/no renderer provider/)
    expect(() => assertRendererRegistryMatches([{ id: 'ollama' }, { id: 'tabby' }])).not.toThrow()
  })

  it('isolates same model name across providers', () => {
    const ollama = getRendererProvider('ollama')
    const tabby = getRendererProvider('tabby')
    expect(ollama.id).not.toBe(tabby.id)
    expect(ollama.ModelProfileEditor).not.toBe(tabby.ModelProfileEditor)
  })

  it('drives selector and required slots from a fake provider definition', () => {
    const fakeId = 'fake-provider'
    const SettingsEditor = () => null
    const ModelProfileEditor = () => null
    const AcquisitionPanel = () => null
    const fakeDefinition = {
      id: fakeId,
      descriptorId: fakeId,
      SettingsEditor,
      ModelProfileEditor,
      AcquisitionPanel
    } as unknown as RendererProviderDefinition
    const registry = { ...RENDERER_PROVIDERS, [fakeId]: fakeDefinition }
    const definitions = resolveRendererProviders(
      [{ id: 'ollama' }, { id: 'tabby' }, { id: fakeId }],
      registry
    )

    expect(definitions.map(({ id }) => id)).toEqual(['ollama', 'tabby', fakeId])
    expect(definitions[2]).toMatchObject({
      SettingsEditor,
      ModelProfileEditor,
      AcquisitionPanel
    })
    expect(
      modelRefKey({ providerId: 'ollama', modelId: 'same-name' })
    ).not.toBe(
      modelRefKey({ providerId: 'tabby', modelId: 'same-name' })
    )
  })

  it('silently skips missing optional slots but shows missing required adapters', () => {
    const optionalMissing = {
      ...RENDERER_PROVIDERS.ollama,
      ...Object.fromEntries(OPTIONAL_RENDERER_SLOTS.map((slot) => [slot, undefined]))
    } as unknown as RendererProviderDefinition<'ollama'>
    const registry = { ollama: optionalMissing }

    for (const slot of OPTIONAL_RENDERER_SLOTS) {
      expect(renderProviderSlot('ollama', slot, {}, registry), slot).toBeNull()
    }

    const requiredMissing = {
      ...RENDERER_PROVIDERS.ollama,
      AcquisitionPanel: undefined
    } as unknown as RendererProviderDefinition<'ollama'>
    const result = renderProviderSlot('ollama', 'AcquisitionPanel', {}, {
      ollama: requiredMissing
    })

    expect(isValidElement(result)).toBe(true)
    expect(result).toMatchObject({ type: MissingProviderSlot })
    expect(REQUIRED_RENDERER_SLOTS).toContain('AcquisitionPanel')
  })
})

describe('generic renderer pages', () => {
  it('contain no direct Ollama/Tabby branching', () => {
    const files = [
      'src/pages/Models.tsx',
      'src/pages/Server.tsx',
      'src/pages/Logs.tsx',
      'src/pages/ResourceUsage.tsx',
      'src/components/Layout.tsx',
      'src/components/LogPanel.tsx',
      'src/components/LoadedModelDetailsDialog.tsx'
    ]
    const backendBranch =
      /(?:===|!==)\s*['"](?:ollama|tabby)['"]|case\s+['"](?:ollama|tabby)['"]|\bisTabby\b/i

    for (const file of files) {
      expect(readFileSync(resolve(process.cwd(), file), 'utf-8'), file).not.toMatch(
        backendBranch
      )
    }
  })
})
