'use client'

import { createContext, useContext, useMemo } from 'react'
import '@/lib/i18n/catalog'
import { localeTagFor, pluralFor, translateTemplate, translateText, type Lang } from '@/lib/i18n/core'

const LangContext = createContext<Lang>('en')

export function LangProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>
}

/** The server API for client components: English in the code, Russian from the catalogs. */
export function useT() {
  const lang = useContext(LangContext)
  return useMemo(
    () => ({
      lang,
      t: (strings: TemplateStringsArray, ...values: unknown[]) => translateTemplate(lang, strings, values),
      tr: (text: string) => translateText(lang, text),
      plural: (n: number, forms: [string, string] | [string, string, string]) => pluralFor(lang, n, forms),
      localeTag: localeTagFor(lang),
    }),
    [lang],
  )
}
