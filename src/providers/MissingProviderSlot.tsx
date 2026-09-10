import { useI18n } from '../i18n/I18nProvider'
import type { BackendId } from '../../shared/backend-contract'

export interface MissingProviderSlotProps {
  providerId: BackendId | string
  slot: string
}

export default function MissingProviderSlot({ providerId, slot }: MissingProviderSlotProps): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="alert alert-info" role="status">
      {t('providers.missingSlot', { providerId, slot })}
    </div>
  )
}
