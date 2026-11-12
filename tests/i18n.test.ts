import { describe, expect, it } from 'vitest'
import { findCyrillic, missingKeys, plural, registerCatalog, runWithLang, t, tr, trc } from '@/lib/i18n'
import { formatAgo, formatWhen } from '@/lib/format'
import { formatEta, formatSize } from '@/lib/connectors/format'

registerCatalog({ 'Found {0} {1}:': 'Найдено {0} {1}:', '{0} before {1}': '{1} после {0}' }, { document: ['документ', 'документа', 'документов'] })

const docs = (n: number) => plural(n, ['document', 'documents'])

describe('i18n core', () => {
  it('English is the code itself', () => {
    runWithLang('en', () => {
      expect(t`Found ${3} ${docs(3)}:`).toBe('Found 3 documents:')
      expect(docs(1)).toBe('document')
      expect(docs(0)).toBe('documents')
      expect(tr('No key')).toBe('No key')
    })
  })

  it('Russian comes from the catalog, with Russian plural rules and free placeholder order', () => {
    runWithLang('ru', () => {
      expect(t`Found ${3} ${docs(3)}:`).toBe('Найдено 3 документа:')
      expect(docs(21)).toBe('документ')
      expect(docs(11)).toBe('документов')
      expect(docs(5)).toBe('документов')
      expect(t`${'a'} before ${'b'}`).toBe('b после a')
    })
  })

  it('a missing Russian key falls back to English and is recorded', () => {
    runWithLang('ru', () => expect(tr('No key')).toBe('No key'))
    expect(missingKeys()).toContain('No key')
  })

  it('addresses and codes are not reported as missing', () => {
    runWithLang('ru', () => [tr('http://jackett:9117'), tr('org_…'), tr('en')])
    expect(missingKeys().filter((k) => ['http://jackett:9117', 'org_…', 'en'].includes(k))).toEqual([])
  })

  it('legacy three Russian forms stay Russian in both languages until their module is translated', () => {
    const legacy = (n: number) => plural(n, ['торрент', 'торрента', 'торрентов'])
    expect(runWithLang('en', () => legacy(3))).toBe('торрента')
    expect(runWithLang('ru', () => legacy(5))).toBe('торрентов')
  })

  it('a context separates the same English word', () => {
    registerCatalog({ 'filter|stopped': 'остановлены', stopped: 'остановлен' })
    expect(runWithLang('ru', () => [trc('filter', 'stopped'), tr('stopped')])).toEqual(['остановлены', 'остановлен'])
    expect(runWithLang('en', () => trc('filter', 'stopped'))).toBe('stopped')
    expect(runWithLang('ru', () => trc('filter', 'unknown'))).toBe('unknown')
  })

  it('finds Cyrillic', () => {
    expect(findCyrillic('ok Привет мир')).toBe('Привет мир')
    expect(findCyrillic('all English')).toBeNull()
  })
})

describe('formatting in both languages', () => {
  const now = new Date(2026, 8, 13, 12, 0)
  const at = (d: number, h: number, m: number) => new Date(2026, 8, d, h, m)

  it('English', () => {
    runWithLang('en', () => {
      expect(formatAgo(new Date(now.getTime() - 10_000), now)).toBe('just now')
      expect(formatAgo(new Date(now.getTime() - 3 * 60_000), now)).toBe('3 min ago')
      expect(formatAgo(new Date(now.getTime() - 130 * 60_000), now)).toBe('2 h ago')
      expect(formatWhen(at(12, 21, 40), now)).toBe('yesterday 21:40')
      expect(formatWhen(at(13, 9, 14), now)).toBe('today 09:14')
      expect(formatWhen(at(1, 21, 40), now)).toBe('Sep 1, 21:40')
      expect(formatSize(1.5 * 1024 * 1024)).toBe('1.5 MB')
      expect(formatEta(125 * 60)).toBe('2 h 5 min')
      expect(formatEta((3 * 24 + 4) * 3600)).toBe('3 d 4 h')
      expect(formatEta(20)).toBe('<1 min')
    })
  })

  it('Russian stays as it was', () => {
    runWithLang('ru', () => {
      expect(formatAgo(new Date(now.getTime() - 10_000), now)).toBe('только что')
      expect(formatAgo(new Date(now.getTime() - 3 * 60_000), now)).toBe('3 мин назад')
      expect(formatAgo(new Date(now.getTime() - 130 * 60_000), now)).toBe('2 ч назад')
      expect(formatWhen(at(12, 21, 40), now)).toBe('вчера 21:40')
      expect(formatWhen(at(13, 9, 14), now)).toBe('сегодня 09:14')
      expect(formatWhen(at(1, 21, 40), now)).toBe('1 сент, 21:40')
      expect(formatSize(1.5 * 1024 * 1024)).toBe('1,5 МБ')
      expect(formatEta(125 * 60)).toBe('2 ч 5 мин')
      expect(formatEta((3 * 24 + 4) * 3600)).toBe('3 дн 4 ч')
      expect(formatEta(20)).toBe('<1 мин')
    })
  })
})
