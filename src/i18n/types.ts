export type Locale = 'cs' | 'en'

export const LOCALES: Locale[] = ['cs', 'en']

export const DEFAULT_LOCALE: Locale = 'cs'

export const LOCALE_STORAGE_KEY = 'ollamastudio.language'

export function isLocale(value: unknown): value is Locale {
  return value === 'cs' || value === 'en'
}

export function localeTag(locale: Locale): string {
  return locale === 'cs' ? 'cs-CZ' : 'en-US'
}

export function localeHtmlLang(locale: Locale): string {
  return locale
}
