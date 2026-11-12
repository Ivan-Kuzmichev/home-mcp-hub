import { AsyncLocalStorage } from 'node:async_hooks'
import { getSetting, setSetting } from '../settings'
import { isLang, translateText, type Lang } from './core'

const SETTING = 'language'

const globalForLang = globalThis as unknown as { __hubLangStore?: AsyncLocalStorage<Lang>; __hubLang?: Lang }
const store = (globalForLang.__hubLangStore ??= new AsyncLocalStorage<Lang>())

/** HUB_LANG fixes the language (tests, the demo); the setting is then ignored. */
export function langFromEnv(): Lang | null {
  const v = process.env.HUB_LANG
  return isLang(v) ? v : null
}

/** One language for the whole hub: an explicit run, then HUB_LANG, then the setting, English by default. */
export function getLang(): Lang {
  const scoped = store.getStore()
  if (scoped) return scoped
  const env = langFromEnv()
  if (env) return env
  if (globalForLang.__hubLang === undefined) {
    let stored: string | null
    try {
      stored = getSetting(SETTING)
    } catch {
      // No database (the build prerenders pages): English, and ask again next time.
      return 'en'
    }
    globalForLang.__hubLang = isLang(stored) ? stored : 'en'
  }
  return globalForLang.__hubLang
}

/** The settings switch. With HUB_LANG set it would change nothing visible, so it says so. */
export function changeLanguage(lang: Lang): { ok: true } | { error: string } {
  // A server action argument is untrusted: only a known language gets stored.
  if (!isLang(lang)) return { error: translateText(getLang(), 'Unknown language') }
  if (langFromEnv()) return { error: translateText(getLang(), 'The language is fixed by HUB_LANG') }
  setLang(lang)
  return { ok: true }
}

export function setLang(lang: Lang): void {
  setSetting(SETTING, lang)
  globalForLang.__hubLang = lang
}

/** Forget the cached setting (tests that write the setting directly). */
export function resetLangCache(): void {
  globalForLang.__hubLang = undefined
}

export function runWithLang<T>(lang: Lang, fn: () => T): T {
  return store.run(lang, fn)
}
