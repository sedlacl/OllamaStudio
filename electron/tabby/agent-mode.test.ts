import { describe, expect, it, vi } from 'vitest'
import type { TabbyModelProfile } from '../../shared/backend-contract'
import { ensureTabbyAgentMode, planAgentMode, QWEN_TOOL_FORMAT } from './agent-mode'
import { modelAgentYamlEnabled } from './model-config'

const MODEL = 'Qwen3.8-27B-exl3-SC_3.00bpw_H4-2-2-2'

function deps(overrides: {
  profile: TabbyModelProfile
  configEnabled: boolean
  loaded: boolean
}) {
  const saved: TabbyModelProfile[] = []
  const written: string[] = []
  const reloaded: TabbyModelProfile[] = []
  return {
    saved,
    written,
    reloaded,
    deps: {
      getProfile: () => overrides.profile,
      saveProfile: (profile: TabbyModelProfile) => saved.push(profile),
      isLoaded: async () => overrides.loaded,
      reload: (profile: TabbyModelProfile) => reloaded.push(profile),
      readConfigEnabled: () => overrides.configEnabled,
      writeConfig: (name: string) => written.push(name)
    }
  }
}

describe('planAgentMode', () => {
  it('zapne profil i config a načte běžící model znovu', () => {
    expect(
      planAgentMode({ profileEnabled: false, configEnabled: false, loaded: true })
    ).toEqual({ saveProfile: true, writeConfig: true, reload: true })
  })

  it('nenačítá znovu, když už config parsery má', () => {
    expect(
      planAgentMode({ profileEnabled: false, configEnabled: true, loaded: true })
    ).toEqual({ saveProfile: true, writeConfig: false, reload: false })
  })

  it('nesahá na nenačtený model', () => {
    expect(
      planAgentMode({ profileEnabled: false, configEnabled: false, loaded: false })
    ).toEqual({ saveProfile: true, writeConfig: true, reload: false })
  })
})

describe('ensureTabbyAgentMode', () => {
  it('nastaví profil, config a reload u modelu s vypnutým agentem', async () => {
    const ctx = deps({
      profile: { agent: { enabled: false } } as TabbyModelProfile,
      configEnabled: false,
      loaded: true
    })

    await expect(ensureTabbyAgentMode(MODEL, ctx.deps)).resolves.toEqual({
      alreadyOn: false,
      configWritten: true,
      reloading: true
    })
    expect(ctx.saved[0]?.agent).toEqual({
      enabled: true,
      toolFormat: QWEN_TOOL_FORMAT
    })
    expect(ctx.written).toEqual([MODEL])
    // Reload musí jít s profilem, kde je agent už zapnutý, jinak by si ho load přepsal.
    expect(ctx.reloaded[0]?.agent?.enabled).toBe(true)
  })

  it('zachová ostatní volby profilu', async () => {
    const ctx = deps({
      profile: {
        maxSeqLen: 65536,
        cacheMode: 'Q8',
        agent: { enabled: false }
      } as TabbyModelProfile,
      configEnabled: false,
      loaded: false
    })

    await ensureTabbyAgentMode(MODEL, ctx.deps)
    expect(ctx.saved[0]).toMatchObject({ maxSeqLen: 65536, cacheMode: 'Q8' })
  })

  it('je idempotentní — nic nepřepisuje ani nerestartuje', async () => {
    const ctx = deps({
      profile: {
        agent: { enabled: true, toolFormat: QWEN_TOOL_FORMAT }
      } as TabbyModelProfile,
      configEnabled: true,
      loaded: true
    })

    await expect(ensureTabbyAgentMode(MODEL, ctx.deps)).resolves.toEqual({
      alreadyOn: true,
      configWritten: false,
      reloading: false
    })
    expect(ctx.saved).toEqual([])
    expect(ctx.written).toEqual([])
    expect(ctx.reloaded).toEqual([])
  })

  it('dopíše config, když ho shodil load bez zaškrtnutého agenta', async () => {
    const ctx = deps({
      profile: {
        agent: { enabled: true, toolFormat: QWEN_TOOL_FORMAT }
      } as TabbyModelProfile,
      configEnabled: false,
      loaded: true
    })

    await expect(ensureTabbyAgentMode(MODEL, ctx.deps)).resolves.toMatchObject({
      configWritten: true,
      reloading: true
    })
    expect(ctx.saved).toEqual([])
  })

  it('bez injektovaného readeru nepadá na chybějícím modelu', async () => {
    const write = vi.fn()
    await expect(
      ensureTabbyAgentMode('missing-model', {
        getProfile: () => ({ agent: { enabled: true } }) as TabbyModelProfile,
        saveProfile: () => {},
        isLoaded: async () => false,
        reload: () => {},
        readConfigEnabled: () => false,
        writeConfig: write
      })
    ).resolves.toMatchObject({ configWritten: true })
    expect(write).toHaveBeenCalledOnce()
  })
})

describe('modelAgentYamlEnabled', () => {
  it('vyžaduje reasoning i tool_format', () => {
    expect(
      modelAgentYamlEnabled(
        'model:\n  reasoning: true\n  reasoning_start_token: "<think>"\n  tool_format: qwen3_5\n'
      )
    ).toBe(true)
    expect(modelAgentYamlEnabled('model:\n  reasoning: true\n')).toBe(false)
    expect(modelAgentYamlEnabled('model:\n  reasoning: false\n')).toBe(false)
    expect(modelAgentYamlEnabled('')).toBe(false)
  })

  it('nenechá se zmást jinou sekcí', () => {
    expect(
      modelAgentYamlEnabled(
        'model:\n  reasoning: false\ndraft_model:\n  draft_mode: mtp\n  tool_format: qwen3_5\n'
      )
    ).toBe(false)
  })
})
