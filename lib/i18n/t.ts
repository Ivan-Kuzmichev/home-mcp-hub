import { localeTagFor, pluralFor, translateTemplate, translateText } from './core'
import { getLang } from './lang'

/** t`Found ${n} documents` — English in the code, Russian from the catalog. */
export function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return translateTemplate(getLang(), strings, values)
}

/** A fixed string: field labels, tool and parameter descriptions. */
export function tr(text: string): string {
  return translateText(getLang(), text)
}

export function plural(n: number, forms: [string, string] | [string, string, string]): string {
  return pluralFor(getLang(), n, forms)
}

export function localeTag(): 'en-US' | 'ru-RU' {
  return localeTagFor(getLang())
}
