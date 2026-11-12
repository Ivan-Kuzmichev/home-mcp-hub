import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { changeLanguage, getLang, resetLangCache, setLang } = await import('@/lib/i18n')
const { jackett } = await import('@/lib/connectors/jackett')
const { dedupe, rank } = await import('@/lib/connectors/jackett/search')

afterAll(cleanup)

const pinned = process.env.HUB_LANG
afterEach(() => {
  process.env.HUB_LANG = pinned
})

describe('fixes from the branch review', () => {
  it('dedupe keeps a release with another audio language so rank can put it first', () => {
    const r = (title: string, seeders: number) => ({ title, tracker: 'T', size: 1, seeders, date: '', tags: [], russian: false })
    const out = rank(dedupe([r('Movie.2024.1080p.WEB-DL', 500), r('Movie.2024.GERMAN.DL.1080p.WEB-DL', 40)]), 'de')
    expect(out.map((x) => x.seeders)).toEqual([40, 500])
  })

  it('search_torrents takes the language code in any case', () => {
    const tool = jackett.tools.find((x) => x.name === 'search_torrents')!
    expect(tool.inputSchema.safeParse({ query: 'x', language: 'DE' })).toMatchObject({ success: true, data: { language: 'de' } })
    expect(tool.inputSchema.safeParse({ query: 'x', language: ' Any ' })).toMatchObject({ success: true, data: { language: 'any' } })
  })

  it('the language switch refuses an unknown value instead of storing it', () => {
    delete process.env.HUB_LANG
    resetLangCache()
    setLang('ru')
    expect(changeLanguage('de' as never)).toEqual({ error: expect.any(String) })
    resetLangCache()
    expect(getLang()).toBe('ru')
  })
})
