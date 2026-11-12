// Translation core without server dependencies: usable from client components too.
// English is the text in the code and the key; Russian comes from ru.ts catalogs next to the code.

export type Lang = 'en' | 'ru'
export const LANGS: readonly Lang[] = ['en', 'ru']

type RuForms = [string, string, string]

const texts = new Map<string, string>()
const plurals = new Map<string, RuForms>()
const missing = new Set<string>()
const conflicts: string[] = []

/** One English text maps to one Russian across all catalogs; a second, different Russian is a conflict. */
export function registerCatalog(entries: Record<string, string>, pluralForms: Record<string, RuForms> = {}): void {
  for (const [en, ru] of Object.entries(entries)) {
    const prev = texts.get(en)
    if (prev !== undefined && prev !== ru) conflicts.push(`${en} → ${prev} | ${ru}`)
    texts.set(en, ru)
  }
  for (const [one, forms] of Object.entries(pluralForms)) {
    const prev = plurals.get(one)
    if (prev && prev.join() !== forms.join()) conflicts.push(`plural ${one} → ${prev.join('/')} | ${forms.join('/')}`)
    plurals.set(one, forms)
  }
}

/** For the coverage test: catalogs that disagree on the Russian for the same English. */
export function catalogConflicts(): string[] {
  return [...conflicts]
}

export function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'ru'
}

/** `Found ${n} ${w}:` → `Found {0} {1}:` */
function templateKey(strings: readonly string[]): string {
  return strings.reduce((key, part, i) => (i === 0 ? part : `${key}{${i - 1}}${part}`), '')
}

function interpolate(strings: readonly string[], values: readonly unknown[]): string {
  return strings.reduce((out, part, i) => (i === 0 ? part : `${out}${String(values[i - 1])}${part}`), '')
}

export function translateTemplate(lang: Lang, strings: readonly string[], values: readonly unknown[]): string {
  if (lang === 'en') return interpolate(strings, values)
  const key = templateKey(strings)
  const template = texts.get(key)
  if (template === undefined) {
    missing.add(key)
    return interpolate(strings, values)
  }
  return template.replace(/\{(\d+)\}/g, (_, i: string) => String(values[Number(i)]))
}

/** Addresses, codes and placeholders like «http://jackett:9117» or «org_…»: same in every language. */
const NOT_TEXT = /^(?:[a-z0-9_.:/\-@…#+=?&%]+|[a-z][a-z0-9+.-]*:\/\/\S*)$/

export function translateText(lang: Lang, text: string): string {
  if (lang === 'en') return text
  const ru = texts.get(text)
  if (ru === undefined) {
    if (!NOT_TEXT.test(text)) missing.add(text)
    return text
  }
  return ru
}

/** Same English word, different Russian (a state «stopped» vs a filter «stopped»): the key carries a context. */
export function translateInContext(lang: Lang, context: string, text: string): string {
  if (lang === 'en') return text
  const key = `${context}|${text}`
  const ru = texts.get(key)
  if (ru === undefined) {
    missing.add(key)
    return text
  }
  return ru
}

/** The Russian rule: 1 документ, 3 документа, 5 документов. */
function ruPlural(n: number, forms: RuForms): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
  return forms[2]
}

/**
 * [one, other] in English; Russian forms come from the catalog by `one`.
 * Three forms are the old Russian call, kept as is until its module is translated.
 */
export function pluralFor(lang: Lang, n: number, forms: [string, string] | RuForms, context?: string): string {
  if (forms.length === 3) return ruPlural(n, forms)
  if (lang === 'en') return n === 1 ? forms[0] : forms[1]
  // A context picks another Russian case for the same English word: «for 3 documents» = «для 3 документов».
  const key = context ? `${context}|${forms[0]}` : forms[0]
  const ru = plurals.get(key)
  if (!ru) {
    missing.add(`plural:${key}`)
    return n === 1 ? forms[0] : forms[1]
  }
  return ruPlural(n, ru)
}

export function localeTagFor(lang: Lang): 'en-US' | 'ru-RU' {
  return lang === 'ru' ? 'ru-RU' : 'en-US'
}

/** Keys not found in the Russian catalog since start: coverage tests read it. */
export function missingKeys(): string[] {
  return [...missing]
}

export function clearMissingKeys(): void {
  missing.clear()
}

/** The first run of Cyrillic text, or null: untranslated text in English mode. */
export function findCyrillic(text: string): string | null {
  return /[Ѐ-ӿ][Ѐ-ӿ\s]*/.exec(text)?.[0].trim() ?? null
}
