import { useState } from 'react'
import type { TabbyConfig, TabbyPreflightResult } from '../../../shared/backend-contract'
import { useI18n } from '../../i18n/I18nProvider'
import { api } from '../../types/api'
import type { RendererProviderDefinition } from '../types'
import type { ProviderSettingsEditorProps } from '../types'
import TabbyAcquisitionPanel from './AcquisitionPanel'
import TabbyLayoutNotice from './LayoutNotice'
import TabbyLogMaintenance from './LogMaintenance'
import TabbyLogsPageNotice from './LogsPageNotice'
import TabbyModelProfileEditor from './ModelProfileEditor'
import TabbySettingsEditor from './SettingsEditor'
import TabbyStatusBadges from './StatusBadges'

function TabbySettingsSlot({
  settings,
  onSettingsChange
}: ProviderSettingsEditorProps): JSX.Element {
  const { t } = useI18n()
  const config = settings as TabbyConfig
  const [preflight, setPreflight] = useState<TabbyPreflightResult | null>(null)
  const [preflightBusy, setPreflightBusy] = useState(false)

  const runPreflight = async (): Promise<void> => {
    setPreflightBusy(true)
    try {
      setPreflight(
        await api().invokeProviderAction({
          providerId: 'tabby',
          action: 'runtime.preflight',
          payload: {}
        })
      )
    } catch (error) {
      setPreflight({
        ok: false,
        installDir: config.installDir ?? '',
        pythonPath: config.pythonPath ?? '',
        configPath: config.configPath ?? '',
        mainPy: '',
        errors: [error instanceof Error ? error.message : t('server.preflightFailed')],
        warnings: []
      })
    } finally {
      setPreflightBusy(false)
    }
  }

  return (
    <TabbySettingsEditor
      config={config}
      preflight={preflight}
      preflightBusy={preflightBusy}
      onConfigChange={(key, value) => onSettingsChange({ ...config, [key]: value })}
      onRunPreflight={() => void runPreflight()}
    />
  )
}

export const tabbyRendererProvider: RendererProviderDefinition<'tabby'> = {
  id: 'tabby',
  descriptorId: 'tabby',
  SettingsEditor: TabbySettingsSlot,
  ModelProfileEditor: TabbyModelProfileEditor,
  AcquisitionPanel: TabbyAcquisitionPanel,
  StatusBadges: TabbyStatusBadges,
  getConfiguredRuntimeBinary: (settings) =>
    String((settings as TabbyConfig | undefined)?.pythonPath ?? '').trim() || null,
  deleteIncompleteModel: (modelId) =>
    api().invokeProviderAction({
      providerId: 'tabby',
      action: 'download.delete-folder',
      payload: { folderName: modelId }
    }),
  LayoutNotice: TabbyLayoutNotice,
  LogMaintenance: TabbyLogMaintenance,
  LogsPageNotice: TabbyLogsPageNotice
}

export { DEFAULT_TABBY_CONFIG } from './defaults'
export { default as TabbyModelProfileEditor } from './ModelProfileEditor'
export { default as TabbySettingsEditor } from './SettingsEditor'
export { default as TabbyAcquisitionPanel } from './AcquisitionPanel'
export { default as TabbyStatusBadges } from './StatusBadges'
export { default as TabbyLayoutNotice } from './LayoutNotice'
export { default as TabbyLogMaintenance } from './LogMaintenance'
export { default as TabbyLogsPageNotice } from './LogsPageNotice'
