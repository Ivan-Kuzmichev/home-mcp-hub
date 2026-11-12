import { afterAll, describe, expect, it } from 'vitest'
import { connectorLanguageGaps, setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { CONNECTORS } = await import('@/lib/connectors/registry')
const { catalogConflicts } = await import('@/lib/i18n')

afterAll(cleanup)

/** A config that parses for every connector: the smallest valid values. */
const SAMPLE: Record<string, Record<string, unknown>> = {
  jackett: { baseUrl: 'http://jackett:9117', apiKey: 'k' },
  qbittorrent: { baseUrl: 'http://qbittorrent:8080', authMode: 'none' },
  transmission: { baseUrl: 'http://transmission:9091', authMode: 'none' },
  torrserve: { baseUrl: 'http://torrserve:8090', authMode: 'none' },
  paperless: { baseUrl: 'http://paperless:8000', apiToken: 't' },
  papra: { baseUrl: 'http://papra:1221', apiKey: 'k' },
  files: { folders: 'Docs | /files/docs | edit' },
  browser: { baseUrl: 'http://camofox:9377', accessKey: 'k', apiKey: 'k', allowActions: true, vncUrl: 'http://192.168.1.5:6080' },
  mitmproxy: { baseUrl: 'http://mitmweb:8081', allowMocks: true },
  prototypes: {},
  scripts: {},
}

describe('every connector speaks both languages', () => {
  it.each(CONNECTORS.map((c) => [c.id, c] as const))('%s', async (id, c) => {
    const parsed = c.parseConfig(SAMPLE[id] ?? {})
    expect(parsed.ok, `sample config for ${id}`).toBe(true)
    expect(await connectorLanguageGaps(c, parsed.ok ? parsed.config : {})).toEqual({ cyrillic: null, missing: [] })
  })

  it('catalogs agree: one English text, one Russian', () => {
    expect(catalogConflicts()).toEqual([])
  })

  it('every connector has a sample config here', () => {
    expect(CONNECTORS.map((c) => c.id).filter((id) => !(id in SAMPLE))).toEqual([])
  })
})
