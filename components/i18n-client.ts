// t/tr/plural for client components: no hooks, so helpers outside components can use them too.
// LangProvider sets the language while it renders, before any child renders; the hub has one
// language, so the server render of a client component and the browser agree.
import '@/lib/i18n/catalog'
import { localeTagFor, pluralFor, translateInContext, translateTemplate, translateText, type Lang } from '@/lib/i18n/core'

let current: Lang = 'en'

export function setClientLang(lang: Lang): void {
  current = lang
}

export function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return translateTemplate(current, strings, values)
}

export function tr(text: string): string {
  return translateText(current, text)
}

export function trc(context: string, text: string): string {
  return translateInContext(current, context, text)
}

export function plural(n: number, forms: [string, string], context?: string): string {
  return pluralFor(current, n, forms, context)
}

export function localeTag(): 'en-US' | 'ru-RU' {
  return localeTagFor(current)
}
