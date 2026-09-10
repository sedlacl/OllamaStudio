import type { BackendConfigMap, OllamaEnvConfig } from '../../../shared/backend-contract'
import { api } from '../../types/api'
import type { RendererProviderDefinition } from '../types'
import type { ProviderSettingsEditorProps } from '../types'
import OllamaAcquisitionPanel from './AcquisitionPanel'
import OllamaModelProfileEditor from './ModelProfileEditor'
import OllamaSettingsEditor from './SettingsEditor'
import OllamaModelDetails from './ModelDetails'
import OllamaServeErrorActions from './ServeErrorActions'
import OllamaStatusBadges from './StatusBadges'

function OllamaSettingsSlot({
  settings,
  saving,
  onSettingsChange
}: ProviderSettingsEditorProps): JSX.Element {
  const config = settings as BackendConfigMap['ollama']
  const update = (patch: Partial<BackendConfigMap['ollama']>): void => {
    onSettingsChange({ ...config, ...patch })
  }
  return (
    <OllamaSettingsEditor
      ollamaEnv={config.env}
      autoStartServe={config.autoStartServe}
      saving={saving}
      onEnvChange={(key: keyof OllamaEnvConfig, value: string) =>
        update({ env: { ...config.env, [key]: value } })
      }
      onAutoStartChange={(value) => update({ autoStartServe: value })}
      onApplyServePreset={(data) =>
        update({
          env: { ...config.env, ...data.ollamaEnv },
          autoStartServe: data.autoStartServe ?? config.autoStartServe
        })
      }
    />
  )
}

export const ollamaRendererProvider: RendererProviderDefinition<'ollama'> = {
  id: 'ollama',
  descriptorId: 'ollama',
  SettingsEditor: OllamaSettingsSlot,
  ModelProfileEditor: OllamaModelProfileEditor,
  AcquisitionPanel: OllamaAcquisitionPanel,
  StatusBadges: OllamaStatusBadges,
  detectRuntimeBinary: () => api().detectOllamaBinary(),
  ModelDetails: OllamaModelDetails,
  ServeErrorActions: OllamaServeErrorActions
}

export { EMPTY_OLLAMA_ENV } from './defaults'
export { default as OllamaModelProfileEditor } from './ModelProfileEditor'
export { default as OllamaSettingsEditor } from './SettingsEditor'
export { default as OllamaAcquisitionPanel } from './AcquisitionPanel'
export { default as OllamaStatusBadges } from './StatusBadges'
