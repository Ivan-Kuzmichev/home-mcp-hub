import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { configOf, mockFetch, runTool, setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { jackett } = await import('@/lib/connectors/jackett')
const { JackettClient, stripApiKey } = await import('@/lib/connectors/jackett/client')
const { matchesSeason, parseQuality, qualityTags, hasRussianAudio } = await import('@/lib/connectors/jackett/parse')
const { searchAll, dedupe } = await import('@/lib/connectors/jackett/search')
const { getCachedResult } = await import('@/lib/mcp/result-cache')
const { resolveResult } = await import('@/lib/connectors/resolve')
const { getDb } = await import('@/lib/db')
const { searchResult } = await import('@/lib/db/schema')

const BASE = 'http://jackett:9117'
const KEY = 'secretkey123'
const cfg = configOf(jackett, { baseUrl: BASE, apiKey: KEY, minSeeders: '1' })

const INDEXERS_XML = `<?xml version="1.0"?><indexers>
<indexer id="rutracker" configured="true"><title>RuTracker.org</title></indexer>
<indexer id="kinozal" configured="true"><title>Kinozal</title></indexer>
<indexer id="slowtracker" configured="true"><title>Slow &amp; Steady</title></indexer></indexers>`

const hash = (c: string) => c.repeat(40)
function result(over: Record<string, unknown>) {
  return { Tracker: 'RuTracker.org', TrackerId: 'rutracker', Title: 'x', Link: null, MagnetUri: null, InfoHash: null, Size: 10e9, Seeders: 50, Peers: 1, PublishDate: '2025-01-17T10:00:00', Category: [5000], ...over }
}

const RESULTS: Record<string, unknown[]> = {
  rutracker: [
    result({ Title: 'Разделение / Severance / Сезон: 2 / Серии: 1-10 из 10 (Бен Стиллер) [2025, WEB-DL 1080p] MVO (HDrezka Studio)', Link: `${BASE}/dl/rutracker/?jackett_apikey=${KEY}&path=abc&file=Severance`, Seeders: 120 }),
    result({ Title: 'Severance.S02.2160p.ATVP.WEB-DL.DV.HDR.Original', MagnetUri: `magnet:?xt=urn:btih:${hash('a')}`, Seeders: 40 }),
    result({ Title: 'Severance.S01.1080p.WEB-DL', MagnetUri: `magnet:?xt=urn:btih:${hash('b')}`, Seeders: 300 }),
  ],
  kinozal: [
    // same infohash as the rutracker 2160p release, fewer seeders → dropped
    result({ Tracker: 'Kinozal', TrackerId: 'kinozal', Title: 'Severance.S02.2160p.WEB-DL.DV', InfoHash: hash('a').toUpperCase(), Seeders: 10 }),
    result({ Tracker: 'Kinozal', TrackerId: 'kinozal', Title: 'Разделение (2 сезон) 1080p WEB-DL Дубляж', MagnetUri: `magnet:?xt=urn:btih:${hash('c')}`, Seeders: 0 }),
  ],
}

function jackettServer(slow = false) {
  return mockFetch(async (c) => {
    if (c.url.searchParams.get('t') === 'indexers') return new Response(INDEXERS_XML)
    const m = /indexers\/([^/]+)\/results$/.exec(c.url.pathname)
    if (m) {
      if (m[1] === 'slowtracker') {
        if (!slow) return Response.json({ Results: [] })
        const signal = (vi.mocked(fetch).mock.calls.at(-1)?.[1] as RequestInit | undefined)?.signal
        await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      }
      return Response.json({ Results: RESULTS[m[1]!] ?? [], Indexers: [] })
    }
    if (c.url.pathname === '/api/v2.0/server/config') return Response.json({ app_version: '0.24.2389' })
    return new Response('nope', { status: 404 })
  })
}

afterEach(() => vi.unstubAllGlobals())
afterAll(cleanup)

describe('title parsing', () => {
  it('extracts quality and audio', () => {
    expect(qualityTags(parseQuality('Severance.S02.2160p.ATVP.WEB-DL.DV.HDR'))).toEqual(['2160p', 'WEB-DL', 'HDR'])
    expect(qualityTags(parseQuality('Дюна 2 [2024, BDRip 1080p] Dub + Original'))).toEqual(['1080p', 'BluRay', 'дубляж', 'оригинал'])
    expect(hasRussianAudio('Severance.S02.1080p.WEB-DL.MVO')).toBe(true)
    expect(hasRussianAudio('Severance.S02.1080p.WEB-DL')).toBe(false)
  })

  it.each([
    ['Severance.S02.1080p', 2, undefined, true],
    ['Severance.S02E05.1080p', 2, 5, true],
    ['Severance.S02E05.1080p', 2, 6, false],
    ['Разделение / Сезон: 2 / Серии: 1-10 из 10', 2, 7, true],
    ['Разделение (2 сезон) 1080p', 2, undefined, true],
    ['The Office S01-S09 Complete', 4, undefined, true],
    ['Severance.S01.1080p', 2, undefined, false],
    ['Severance Season 2 Complete', 2, 3, true],
  ])('%s — season %s episode %s → %s', (title, season, episode, expected) => {
    expect(matchesSeason(title, season, episode)).toBe(expected)
  })
})

describe('search', () => {
  it('returns partial results and names indexers that missed the deadline', async () => {
    jackettServer(true)
    const client = new JackettClient({ baseUrl: BASE, apiKey: KEY })
    const out = await searchAll(client, await client.indexers(), { query: 'Severance', type: 'tv', season: 2, language: 'ru', minSeeders: 1, limit: 10 }, 150)
    expect(out.failed).toEqual([{ name: 'Slow & Steady', reason: 'timeout' }])
    const titles = out.releases.map((r) => r.title)
    // season 1 filtered out, zero-seed release filtered out, duplicate infohash merged
    expect(titles).toHaveLength(2)
    expect(titles[0]).toContain('HDrezka') // Russian audio first
    expect(out.releases.find((r) => r.title.includes('2160p'))?.tracker).toBe('RuTracker.org')
  })

  it('keeps one release per tracker and quality', () => {
    const r = (title: string, seeders: number, tracker = 'T') => ({ title, tracker, size: 1, seeders, date: '', tags: [], russian: false })
    expect(dedupe([r('A.1080p.WEB-DL', 5), r('A.1080p.WEB-DL.v2', 50), r('A.720p.WEB-DL', 1), r('A.1080p.WEB-DL', 3, 'U')]).map((x) => x.seeders)).toEqual([50, 3, 1])
  })

  it('search_torrents answers with result_ids and never leaks the API key', async () => {
    const calls = jackettServer()
    const text = await runTool(jackett, 'search_torrents', cfg, { query: 'Severance', type: 'tv', season: 2 })
    expect(text).toMatch(/^Найдено 2, показаны 2 лучших:/)
    expect(text).toMatch(/r_[0-9a-z]{5} · Разделение/)
    expect(text).toContain('1080p, WEB-DL, многоголосый')
    expect(text).not.toContain(KEY)
    expect(calls.find((c) => c.url.pathname.endsWith('/results'))?.url.searchParams.getAll('Category[]')).toEqual(['5000'])

    const rows = getDb().select().from(searchResult).all()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => !row.payloadJson.includes(KEY))).toBe(true)
  })

  it('reports when nothing is found', async () => {
    jackettServer()
    expect(await runTool(jackett, 'search_torrents', cfg, { query: 'Severance', season: 9 })).toContain('Ничего не найдено')
  })

  it('test() counts indexers', async () => {
    jackettServer()
    expect(await jackett.test(cfg)).toMatchObject({ ok: true, summary: '3 индексатора', details: ['Jackett 0.24.2389', expect.stringMatching(/мс$/)] })
  })
})

describe('result_id resolution', () => {
  async function cacheOne() {
    jackettServer()
    const text = await runTool(jackett, 'search_torrents', cfg, { query: 'Severance', type: 'tv', season: 2 })
    return /(r_[0-9a-z]{5}) · Разделение/.exec(text)![1]!
  }

  it('downloads the .torrent through Jackett with the key added back', async () => {
    const id = await cacheOne()
    const torrent = new TextEncoder().encode('d4:infod4:name1:xee')
    const calls = mockFetch(() => new Response(torrent))
    const r = await resolveResult(id, { baseUrl: 'http://10.0.0.5:9117', apiKey: KEY })
    expect(r).toMatchObject({ kind: 'file', infoHash: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(calls[0]!.url.host).toBe('10.0.0.5:9117')
    expect(calls[0]!.url.searchParams.get('jackett_apikey')).toBe(KEY)
  })

  it('follows a redirect to a magnet', async () => {
    const id = await cacheOne()
    const magnet = `magnet:?xt=urn:btih:${hash('d')}`
    mockFetch(() => new Response(null, { status: 302, headers: { location: magnet } }))
    expect(await resolveResult(id, { baseUrl: BASE, apiKey: KEY })).toMatchObject({ kind: 'magnet', uri: magnet, infoHash: hash('d') })
  })

  it('rejects unknown ids and non-torrent bodies', async () => {
    await expect(resolveResult('r_zzzzz', null)).rejects.toThrow('не найден')
    const id = await cacheOne()
    mockFetch(() => new Response('<html>login</html>'))
    await expect(resolveResult(id, { baseUrl: BASE, apiKey: KEY })).rejects.toThrow('не .torrent')
    expect(getCachedResult(id)?.link).not.toContain(KEY)
  })

  it('strips the API key from links', () => {
    expect(stripApiKey(`${BASE}/dl/x/?jackett_apikey=${KEY}&path=p&file=f`)).toBe(`${BASE}/dl/x/?path=p&file=f`)
  })
})
