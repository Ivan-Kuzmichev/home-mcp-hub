import './catalog'

export { catalogConflicts, clearMissingKeys, findCyrillic, isLang, LANGS, missingKeys, registerCatalog, type Lang } from './core'
export { changeLanguage, getLang, langFromEnv, resetLangCache, runWithLang, setLang } from './lang'
export { localeTag, plural, t, tr, trc } from './t'
