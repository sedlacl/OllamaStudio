import { getContinueConfigStatus, matchContinueModel } from './continue-config'
import { getOpenCodeConfigStatus, matchOpenCodeModel } from './opencode-config'
import type { ToolConfigMatch } from './tool-config-shared'

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

export function getIntegrationsStatus(modelNames: string[] = []): IntegrationsStatus {
  const continueStatus = getContinueConfigStatus()
  const opencodeStatus = getOpenCodeConfigStatus()
  const names = modelNames.filter((name) => name.trim())

  const continueByModel: Record<string, ToolConfigMatch> = {}
  const opencodeByModel: Record<string, ToolConfigMatch> = {}
  for (const name of names) {
    continueByModel[name] = matchContinueModel(name)
    opencodeByModel[name] = matchOpenCodeModel(name)
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
