import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { changeLanguage, getLang, resetLangCache, runWithLang, setLang } = await import('@/lib/i18n')
const { setSetting } = await import('@/lib/settings')
const { getMcpHandler } = await import('@/lib/mcp/server')

afterAll(cleanup)

// tests/setup.ts pins HUB_LANG=ru for the old suite; these tests are about the setting itself.
const pinned = process.env.HUB_LANG
beforeEach(() => {
  delete process.env.HUB_LANG
  resetLangCache()
})
afterEach(() => {
  process.env.HUB_LANG = pinned
})

describe('language setting', () => {
  it('English when nothing is stored; the setting wins once saved', () => {
    expect(getLang()).toBe('en')
    setLang('ru')
    expect(getLang()).toBe('ru')
    resetLangCache()
    expect(getLang()).toBe('ru')
  })

  it('an unknown stored value means English', () => {
    setSetting('language', 'de')
    resetLangCache()
    expect(getLang()).toBe('en')
  })

  it('a scoped run overrides everything', () => {
    setLang('ru')
    expect(runWithLang('en', () => getLang())).toBe('en')
  })

  it('switching the language rebuilds the MCP handler', () => {
    setLang('en')
    const en = getMcpHandler()
    expect(getMcpHandler()).toBe(en)
    setLang('ru')
    const ru = getMcpHandler()
    expect(ru).not.toBe(en)
  })

  it('HUB_LANG fixes the language: the switch refuses instead of pretending', () => {
    setLang('ru')
    process.env.HUB_LANG = 'en'
    expect(getLang()).toBe('en')
    expect(changeLanguage('ru')).toEqual({ error: 'The language is fixed by HUB_LANG' })
    delete process.env.HUB_LANG
    expect(changeLanguage('en')).toEqual({ ok: true })
    expect(getLang()).toBe('en')
  })
})
