import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode
} from 'react'
import type { BackendDescriptor, BackendId } from '../../shared/backend-contract'
import { isBackendId } from '../../shared/backend-contract'
import { api } from '../types/api'
import MissingProviderSlot from './MissingProviderSlot'
import { assertRendererRegistryMatches, getRendererProvider, RENDERER_PROVIDERS } from './registry'
import type {
  BackendProviderContextValue,
  ProviderCatalogState,
  RendererProviderDefinition,
  RendererSlot
} from './types'
import { isRequiredRendererSlot } from './types'

const emptyCatalog = (): ProviderCatalogState => ({
  models: [],
  providerErrors: {},
  loading: false,
  lastRefreshAt: null
})

const BackendProviderContext = createContext<BackendProviderContextValue | null>(null)

export function renderProviderSlot(
  providerId: BackendId,
  slot: RendererSlot,
  props: Record<string, unknown>,
  registry: Record<string, RendererProviderDefinition<any>> = RENDERER_PROVIDERS
): ReactNode {
  const definition = registry[providerId]
  if (!definition) {
    return <MissingProviderSlot providerId={providerId} slot={String(slot)} />
  }
  const Component = definition[slot] as ComponentType<Record<string, unknown>> | undefined
  if (!Component) {
    return isRequiredRendererSlot(slot) ? (
      <MissingProviderSlot providerId={providerId} slot={String(slot)} />
    ) : null
  }
  return <Component {...props} />
}

export function BackendProviderContextProvider({ children }: { children: ReactNode }): JSX.Element {
  const [descriptors, setDescriptors] = useState<BackendDescriptor[]>([])
  const [activeProviderId, setActiveProviderId] = useState<BackendId>('ollama')
  const [settingsByProvider, setSettingsByProvider] = useState<Partial<Record<BackendId, unknown>>>({})
  const [catalog, setCatalog] = useState<ProviderCatalogState>(emptyCatalog)

  const catalogAvailable = true

  const descriptorsById = useMemo(() => {
    const map: Partial<Record<BackendId, BackendDescriptor>> = {}
    for (const descriptor of descriptors) {
      map[descriptor.id] = descriptor
    }
    return map
  }, [descriptors])

  const refreshDescriptors = useCallback(async (): Promise<void> => {
    const list = await api().getBackendDescriptors()
    assertRendererRegistryMatches(list)
    setDescriptors(list)
  }, [])

  const refreshSettings = useCallback(async (id?: BackendId): Promise<void> => {
    const targets = id ? [id] : (Object.keys(RENDERER_PROVIDERS) as BackendId[])
    const entries = await Promise.all(
      targets.map(async (providerId) => {
        const settings = await api().getBackendSettings(providerId)
        return [providerId, settings] as const
      })
    )
    setSettingsByProvider((prev) => {
      const next = { ...prev }
      for (const [providerId, settings] of entries) {
        next[providerId] = settings
      }
      return next
    })
  }, [])

  const refreshCatalog = useCallback(async (): Promise<void> => {
    setCatalog((prev) => ({ ...prev, loading: true }))
    try {
      const aggregated = await api().getModelCatalog()
      const providerErrors: Partial<Record<BackendId, string>> = {}
      for (const state of aggregated.providers) {
        if (state.status === 'error' && state.error) {
          providerErrors[state.providerId] = state.error.code
        }
      }
      setCatalog({
        models: aggregated.models,
        providerErrors,
        loading: false,
        lastRefreshAt: aggregated.refreshedAt
      })
    } catch {
      setCatalog((prev) => ({
        ...prev,
        loading: false,
        lastRefreshAt: prev.lastRefreshAt ?? Date.now()
      }))
    }
  }, [])

  useEffect(() => {
    void refreshDescriptors().catch(() => {})
    void api()
      .getServerConfig()
      .then((cfg) => {
        if (isBackendId(cfg.activeBackend)) setActiveProviderId(cfg.activeBackend)
      })
      .catch(() => {})
    void refreshSettings().catch(() => {})
    void refreshCatalog().catch(() => {})
  }, [refreshDescriptors, refreshSettings, refreshCatalog])

  const getDefinition = useCallback(
    <I extends BackendId>(id: I): RendererProviderDefinition<I> | undefined => {
      return RENDERER_PROVIDERS[id]
    },
    []
  )

  const renderSlot = useCallback(
    (
      providerId: BackendId,
      slot: RendererSlot,
      props: Record<string, unknown>
    ): ReactNode => {
      return renderProviderSlot(providerId, slot, props)
    },
    []
  )

  const value = useMemo<BackendProviderContextValue>(
    () => ({
      descriptors,
      descriptorsById,
      activeProviderId,
      setActiveProviderId,
      settingsByProvider,
      refreshSettings,
      refreshDescriptors,
      catalog,
      refreshCatalog,
      catalogAvailable,
      getDefinition,
      renderSlot
    }),
    [
      descriptors,
      descriptorsById,
      activeProviderId,
      settingsByProvider,
      refreshSettings,
      refreshDescriptors,
      catalog,
      refreshCatalog,
      getDefinition,
      renderSlot
    ]
  )

  return <BackendProviderContext.Provider value={value}>{children}</BackendProviderContext.Provider>
}

export function useBackendProviders(): BackendProviderContextValue {
  const ctx = useContext(BackendProviderContext)
  if (!ctx) {
    throw new Error('useBackendProviders must be used within BackendProviderContextProvider')
  }
  return ctx
}

export function useRendererProvider<I extends BackendId>(id: I): RendererProviderDefinition<I> {
  return getRendererProvider(id)
}
