import { localeTagFor, pluralFor, translateInContext, translateTemplate, translateText } from './core'
import { getLang } from './lang'

/** t`Found ${n} documents` — English in the code, Russian from the catalog. */
export function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return translateTemplate(getLang(), strings, values)
}

/** A fixed string: field labels, tool and parameter descriptions. */
export function tr(text: string): string {
  return translateText(getLang(), text)
}

/** tr with a context: trc('filter', 'stopped') — for words whose Russian depends on the use. */
export function trc(context: string, text: string): string {
  return translateInContext(getLang(), context, text)
}

export function plural(n: number, forms: [string, string] | [string, string, string], context?: string): string {
  return pluralFor(getLang(), n, forms, context)
}

export function localeTag(): 'en-US' | 'ru-RU' {
  return localeTagFor(getLang())
}
