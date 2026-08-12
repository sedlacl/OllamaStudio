import { cs, type MessageTree } from './cs'
import { en } from './en'
import {
  DEFAULT_LOCALE,
  isLocale,
  localeHtmlLang,
  localeTag,
  LOCALE_STORAGE_KEY,
  type Locale
} from './types'

export type { Locale, MessageTree }
export { DEFAULT_LOCALE, isLocale, localeHtmlLang, localeTag, LOCALE_STORAGE_KEY }

const catalogs: Record<Locale, MessageTree> = { cs, en }

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never

type Paths<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string ? K : Join<K, Paths<T[K]>>
    }[keyof T & string]

export type MessageKey = Paths<MessageTree>

export type TranslateVars = Record<string, string | number>

function resolvePath(tree: MessageTree, key: MessageKey): string {
  const parts = key.split('.')
  let node: unknown = tree
  for (const part of parts) {
    if (!node || typeof node !== 'object' || !(part in node)) {
      return key
    }
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : key
}

export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: TranslateVars
): string {
  let text = resolvePath(catalogs[locale] ?? catalogs[DEFAULT_LOCALE], key)
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}

/** `null` = uživatel ještě nic neuložil do localStorage. */
export function readStoredLocale(): Locale | null {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocale(raw)) return raw
  } catch {
    /* ignore */
  }
  return null
}

export function writeStoredLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    /* ignore */
  }
}

export function formatNumber(locale: Locale, value: number): string {
  return value.toLocaleString(localeTag(locale))
}

export function formatTime(locale: Locale, ts: number): string {
  return new Date(ts).toLocaleTimeString(localeTag(locale), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function formatDateTime(locale: Locale, ts: number): string {
  return new Date(ts).toLocaleString(localeTag(locale))
}

/** Decimal separator style for percentages under 0.1 */
export function formatTinyPercent(locale: Locale, value: number | null): string {
  if (value == null) return '—'
  if (value > 0 && value < 0.1) {
    return locale === 'cs' ? '<0,1 %' : '<0.1 %'
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} %`
}

export function formatTinyShare(locale: Locale, share: number): string {
  if (share < 0.1) return locale === 'cs' ? '<0,1' : '<0.1'
  return share.toFixed(1)
}
