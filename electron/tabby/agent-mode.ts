/**
 * Agentní režim Tabby modelu pro OpenCode.
 *
 * OpenCode potřebuje, aby Tabby vracela reasoning zvlášť od odpovědi a XML
 * tool cally převáděla na `tool_calls`. To se nastavuje v modelovém
 * `tabby_config.yml` a Tabby to načítá jen při loadu modelu — proto
 * „nastavit v OpenCode“ musí kromě configu řešit i profil a reload.
 */

import type { TabbyModelProfile } from '../../shared/backend-contract'
import { readModelAgentEnabled, writeModelAgentConfig } from './model-config'

/** Tabby `tool_format` pro Qwen3.8 / 3.5 (alias na `qwen3_coder`). */
export const QWEN_TOOL_FORMAT = 'qwen3_5'

export interface AgentModeState {
  /** Profil modelu má agenta zapnutého (přežije další load z dialogu). */
  profileEnabled: boolean
  /** Modelový tabby_config.yml má reasoning i tool_format. */
  configEnabled: boolean
  /** Tenhle model je právě načtený v Tabby. */
  loaded: boolean
}

export interface AgentModePlan {
  saveProfile: boolean
  writeConfig: boolean
  /** Parsery se aplikují až při loadu — běžící model se musí načíst znovu. */
  reload: boolean
}

export function planAgentMode(state: AgentModeState): AgentModePlan {
  const saveProfile = !state.profileEnabled
  const writeConfig = !state.configEnabled
  return {
    saveProfile,
    writeConfig,
    reload: state.loaded && writeConfig
  }
}

export interface AgentModeDeps {
  getProfile: () => TabbyModelProfile
  saveProfile: (profile: TabbyModelProfile) => void
  isLoaded: () => Promise<boolean>
  reload: (profile: TabbyModelProfile) => void
  /** Injektovatelné pro testy — jinak sahá na modelový config na disku. */
  readConfigEnabled?: (modelName: string) => boolean
  writeConfig?: (modelName: string, profile: TabbyModelProfile) => void
}

export interface AgentModeResult {
  /** Už bylo všechno nastavené, nic se nemuselo měnit. */
  alreadyOn: boolean
  configWritten: boolean
  reloading: boolean
}

/**
 * Zapne agentní režim pro model a vrátí, co bylo potřeba udělat.
 * Idempotentní — druhé zavolání nic nepřepisuje ani nerestartuje model.
 */
export async function ensureTabbyAgentMode(
  modelName: string,
  deps: AgentModeDeps
): Promise<AgentModeResult> {
  const profile = deps.getProfile()
  const readConfig = deps.readConfigEnabled ?? readModelAgentEnabled
  const plan = planAgentMode({
    profileEnabled: profile.agent?.enabled === true,
    configEnabled: readConfig(modelName),
    loaded: await deps.isLoaded()
  })

  const next: TabbyModelProfile = plan.saveProfile
    ? { ...profile, agent: { enabled: true, toolFormat: QWEN_TOOL_FORMAT } }
    : profile
  if (plan.saveProfile) deps.saveProfile(next)

  if (plan.writeConfig) {
    const write =
      deps.writeConfig ??
      ((name: string) =>
        writeModelAgentConfig(name, { enabled: true, toolFormat: QWEN_TOOL_FORMAT }))
    write(modelName, next)
  }

  if (plan.reload) deps.reload(next)

  return {
    alreadyOn: !plan.saveProfile && !plan.writeConfig,
    configWritten: plan.writeConfig,
    reloading: plan.reload
  }
}
