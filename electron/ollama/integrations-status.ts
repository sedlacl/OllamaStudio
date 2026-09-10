import { getContinueConfigStatus, matchContinueModel } from './continue-config'
import { getOpenCodeConfigStatus, matchOpenCodeModel } from './opencode-config'
import { modelProfileStore } from '../backends/model-profile-store'
import { modelRefKey, type ModelRef } from '../../shared/backend-contract'
import type { ToolConfigMatch } from './tool-config-shared'
import { toolMatch } from './tool-config-shared'

export interface ToolFileStatus {
  path: string
  exists: boolean
  invalid: boolean
  byModel: Record<string, ToolConfigMatch>
}

export interface IntegrationsStatus {
  continue: ToolFileStatus
  opencode: ToolFileStatus
}

export function getIntegrationsStatus(refs: ModelRef[] = []): IntegrationsStatus {
  const continueStatus = getContinueConfigStatus()
  const opencodeStatus = getOpenCodeConfigStatus()

  const continueByModel: Record<string, ToolConfigMatch> = {}
  const opencodeByModel: Record<string, ToolConfigMatch> = {}
  for (const ref of refs) {
    if (!ref || (ref.providerId !== 'ollama' && ref.providerId !== 'tabby') || !ref.modelId.trim()) {
      continue
    }
    const key = modelRefKey(ref)
    if (ref.providerId !== 'ollama') {
      continueByModel[key] = toolMatch({
        state: 'no-config',
        path: continueStatus.path,
        mismatches: []
      })
      opencodeByModel[key] = matchOpenCodeModel(
        ref,
        modelProfileStore.get({ providerId: 'tabby', modelId: ref.modelId })
      )
    } else {
      const profile = modelProfileStore.get({ providerId: 'ollama', modelId: ref.modelId })
      continueByModel[key] = matchContinueModel(ref, profile)
      opencodeByModel[key] = matchOpenCodeModel(ref, profile)
    }
  }

  return {
    continue: {
      path: continueStatus.path,
      exists: continueStatus.exists,
      invalid: continueStatus.invalid,
      byModel: continueByModel
    },
    opencode: {
      path: opencodeStatus.path,
      exists: opencodeStatus.exists,
      invalid: opencodeStatus.invalid,
      byModel: opencodeByModel
    }
  }
}
