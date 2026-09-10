import type { BackendDescriptor, BackendError, BackendId } from '../../shared/backend-contract'
import type { MessageKey, TranslateVars } from '../i18n'

function asMessageKey(key: string): MessageKey {
  return key as MessageKey
}

type TranslateFn = (key: MessageKey, vars?: TranslateVars) => string

export function providerDisplayName(t: TranslateFn, descriptor: BackendDescriptor | undefined): string {
  if (!descriptor) return '—'
  return t(asMessageKey(descriptor.displayNameKey))
}

export function providerDisplayNameById(
  t: TranslateFn,
  id: BackendId,
  descriptorsById: Partial<Record<BackendId, BackendDescriptor>>
): string {
  return providerDisplayName(t, descriptorsById[id])
}

export function formatBackendError(t: TranslateFn, error: BackendError | undefined): string {
  if (!error?.code) return t('errors.unknown')
  const key = asMessageKey(`errors.${error.code}`)
  const translated = t(key, error.vars as Record<string, string | number> | undefined)
  return translated === key ? error.code : translated
}
