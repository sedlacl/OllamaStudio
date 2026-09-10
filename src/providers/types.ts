import type { ComponentType, ReactNode } from 'react'
import type {
  BackendDescriptor,
  BackendId,
  CatalogModel,
  OllamaEnvConfig,
  TabbyConfig
} from '../../shared/backend-contract'
import type { OllamaUpdateInfo, ServeState, TabbyPreflightResult } from '../types/api'
export type { ServeState } from '../types/api'
import type { OllamaModelProfileEditorProps } from './ollama/ModelProfileEditor'
import type { TabbyModelProfileEditorProps } from './tabby/ModelProfileEditor'

export interface ProviderCatalogState {
  models: CatalogModel[]
  providerErrors: Partial<Record<BackendId, string>>
  loading: boolean
  lastRefreshAt: number | null
}

export interface OllamaSettingsEditorProps {
  ollamaEnv: OllamaEnvConfig
  autoStartServe: boolean
  saving: boolean
  onEnvChange: (key: keyof OllamaEnvConfig, value: string) => void
  onAutoStartChange: (value: boolean) => void
  onApplyServePreset: (data: { ollamaEnv: Partial<OllamaEnvConfig>; autoStartServe?: boolean }) => void
}

export interface TabbySettingsEditorProps {
  config: TabbyConfig
  preflight: TabbyPreflightResult | null
  preflightBusy: boolean
  onConfigChange: <K extends keyof TabbyConfig>(key: K, value: TabbyConfig[K]) => void
  onRunPreflight: () => void
}

export interface AcquisitionPanelProps {
  onModelsChanged?: () => void
  onError?: (message: string) => void
}

export interface OllamaStatusBadgesProps {
  update: OllamaUpdateInfo | null
  checkingUpdate: boolean
  onCheckUpdate: () => void
}

export const REQUIRED_RENDERER_SLOTS = [
  'SettingsEditor',
  'ModelProfileEditor',
  'AcquisitionPanel'
] as const

export const OPTIONAL_RENDERER_SLOTS = [
  'StatusBadges',
  'LayoutNotice',
  'LogMaintenance',
  'LogsPageNotice',
  'ModelDetails',
  'ServeErrorActions'
] as const

export type RequiredRendererSlot = (typeof REQUIRED_RENDERER_SLOTS)[number]
export type OptionalRendererSlot = (typeof OPTIONAL_RENDERER_SLOTS)[number]
export type RendererSlot = RequiredRendererSlot | OptionalRendererSlot

export function isRequiredRendererSlot(slot: RendererSlot): slot is RequiredRendererSlot {
  return (REQUIRED_RENDERER_SLOTS as readonly string[]).includes(slot)
}

export interface TabbyStatusBadgesProps {
  serve: ServeState | null
}

export interface TabbyLayoutNoticeProps {
  serve: ServeState | null
  activeBackend: BackendId
  nowMs: number
}

export interface TabbyLogMaintenanceProps {
  serveState: ServeState | null
  onMessage?: (message: string) => void
}

export interface TabbyLogsPageNoticeProps {
  serve: ServeState | null
}

export interface ProviderSettingsEditorProps {
  settings: unknown
  saving: boolean
  onSettingsChange: (settings: unknown) => void
}

export type ProviderSettingsEditorPropsMap = {
  ollama: OllamaSettingsEditorProps
  tabby: TabbySettingsEditorProps
}

export type ProviderModelProfileEditorPropsMap = {
  ollama: OllamaModelProfileEditorProps
  tabby: TabbyModelProfileEditorProps
}

export interface RendererProviderDefinition<I extends BackendId = BackendId> {
  id: I
  descriptorId: I
  SettingsEditor: ComponentType<ProviderSettingsEditorProps>
  ModelProfileEditor: ComponentType<ProviderModelProfileEditorPropsMap[I]>
  AcquisitionPanel: ComponentType<AcquisitionPanelProps>
  StatusBadges?: ComponentType<{ serve: ServeState | null }>
  detectRuntimeBinary?: () => Promise<string | null>
  getConfiguredRuntimeBinary?: (settings: unknown) => string | null
  deleteIncompleteModel?: (modelId: string) => Promise<{ ok: boolean; error?: string }>
  LayoutNotice?: ComponentType<TabbyLayoutNoticeProps>
  LogMaintenance?: ComponentType<TabbyLogMaintenanceProps>
  LogsPageNotice?: ComponentType<TabbyLogsPageNoticeProps>
  ModelDetails?: ComponentType<{ modelId: string; show?: unknown; config?: unknown }>
  ServeErrorActions?: ComponentType<{
    serve: ServeState | null
    onServeChange?: (state: ServeState) => void
  }>
}

export type RendererProviderRegistry = {
  [I in BackendId]: RendererProviderDefinition<I>
}

export interface BackendProviderContextValue {
  descriptors: BackendDescriptor[]
  descriptorsById: Partial<Record<BackendId, BackendDescriptor>>
  activeProviderId: BackendId
  setActiveProviderId: (id: BackendId) => void
  settingsByProvider: Partial<Record<BackendId, unknown>>
  refreshSettings: (id?: BackendId) => Promise<void>
  refreshDescriptors: () => Promise<void>
  catalog: ProviderCatalogState
  refreshCatalog: () => Promise<void>
  catalogAvailable: boolean
  getDefinition: <I extends BackendId>(id: I) => RendererProviderDefinition<I> | undefined
  renderSlot: (
    providerId: BackendId,
    slot: RendererSlot,
    props: Record<string, unknown>
  ) => ReactNode
}
