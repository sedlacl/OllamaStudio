import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { api } from '../types/api'
import {
  DEFAULT_LOCALE,
  formatDateTime,
  formatNumber,
  formatTime,
  formatTinyPercent,
  formatTinyShare,
  isLocale,
  localeHtmlLang,
  localeTag,
  readStoredLocale,
  translate,
  writeStoredLocale,
  type Locale,
  type MessageKey,
  type TranslateVars
} from './index'

export interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: MessageKey, vars?: TranslateVars) => string
  localeTag: string
  formatNumber: (value: number) => string
  formatTime: (ts: number) => string
  formatDateTime: (ts: number) => string
  formatTinyPercent: (value: number | null) => string
  formatTinyShare: (share: number) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

function applyDocumentLang(locale: Locale): void {
  document.documentElement.lang = localeHtmlLang(locale)
}

export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const initial = readStoredLocale() ?? DEFAULT_LOCALE
    applyDocumentLang(initial)
    return initial
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const stored = readStoredLocale()
        const fromConfig = await api().getAppLanguage()
        if (cancelled) return

        if (stored) {
          if (isLocale(fromConfig) && fromConfig !== stored) {
            await api().setAppLanguage(stored).catch(() => {})
          }
          return
        }

        const next = isLocale(fromConfig) ? fromConfig : DEFAULT_LOCALE
        writeStoredLocale(next)
        applyDocumentLang(next)
        setLocaleState(next)
        if (!isLocale(fromConfig) || fromConfig !== next) {
          await api().setAppLanguage(next).catch(() => {})
        }
      } catch {
        /* preload / first paint */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const setLocale = useCallback((next: Locale) => {
    writeStoredLocale(next)
    applyDocumentLang(next)
    setLocaleState(next)
    void api().setAppLanguage(next).catch(() => {})
  }, [])

  const value = useMemo<I18nContextValue>(() => {
    return {
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
      localeTag: localeTag(locale),
      formatNumber: (n) => formatNumber(locale, n),
      formatTime: (ts) => formatTime(locale, ts),
      formatDateTime: (ts) => formatDateTime(locale, ts),
      formatTinyPercent: (v) => formatTinyPercent(locale, v),
      formatTinyShare: (s) => formatTinyShare(locale, s)
    }
  }, [locale, setLocale])

  return createElement(I18nContext.Provider, { value }, children)
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    throw new Error('useI18n must be used within I18nProvider')
  }
  return ctx
}
