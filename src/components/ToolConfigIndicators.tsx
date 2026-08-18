import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n'
import type { ToolConfigMatch, ToolConfigMismatch, ToolConfigState } from '../types/api'

export type IntegrationTool = 'continue' | 'opencode'

const STATE_CLASS: Record<ToolConfigState, string> = {
  current: 'tool-indicator-current',
  stale: 'tool-indicator-stale',
  missing: 'tool-indicator-missing',
  'no-config': 'tool-indicator-absent',
  invalid: 'tool-indicator-invalid'
}

function mismatchLabel(kind: ToolConfigMismatch, t: (key: MessageKey) => string): string {
  return kind === 'apiBase' ? t('models.mismatchApiBase') : t('models.mismatchContext')
}

export function toolConfigTooltip(
  tool: IntegrationTool,
  match: ToolConfigMatch | undefined,
  t: ReturnType<typeof useI18n>['t']
): string {
  const toolName = t(tool === 'continue' ? 'models.toolContinue' : 'models.toolOpenCode')
  if (!match) return t('models.toolUnknown', { tool: toolName })

  switch (match.state) {
    case 'current': {
      const bits = [
        match.displayName,
        match.apiBase,
        match.contextLength != null ? `ctx ${match.contextLength}` : null
      ].filter(Boolean)
      return t('models.toolCurrent', {
        tool: toolName,
        details: bits.length > 0 ? bits.join(' · ') : t('models.toolCurrentFallback')
      })
    }
    case 'stale':
      return t('models.toolStale', {
        tool: toolName,
        details: match.mismatches.map((m) => mismatchLabel(m, t)).join(', ') || t('models.toolStaleFallback')
      })
    case 'missing':
      return t('models.toolMissing', { tool: toolName })
    case 'no-config':
      return t('models.toolNoConfig', { tool: toolName, path: match.path })
    case 'invalid':
      return t('models.toolInvalid', { tool: toolName, path: match.path })
  }
}

function ToolIndicator({
  tool,
  match
}: {
  tool: IntegrationTool
  match: ToolConfigMatch | undefined
}): JSX.Element {
  const { t } = useI18n()
  const title = toolConfigTooltip(tool, match, t)
  const state = match?.state ?? 'missing'
  const short = tool === 'continue' ? t('models.toolContinueShort') : t('models.toolOpenCodeShort')
  return (
    <span
      className={`tool-indicator ${STATE_CLASS[state]}`}
      title={title}
      aria-label={title}
    >
      {short}
    </span>
  )
}

export default function ToolConfigIndicators({
  continueMatch,
  opencodeMatch
}: {
  continueMatch: ToolConfigMatch | undefined
  opencodeMatch: ToolConfigMatch | undefined
}): JSX.Element {
  return (
    <div className="tool-indicators" role="group">
      <ToolIndicator tool="continue" match={continueMatch} />
      <ToolIndicator tool="opencode" match={opencodeMatch} />
    </div>
  )
}
