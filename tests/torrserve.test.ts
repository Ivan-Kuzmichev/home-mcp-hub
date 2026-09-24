import { afterEach, describe, expect, it, vi } from 'vitest'
import { torrserve } from '@/lib/connectors/torrserve'
import { configOf, mockFetch, runTool, type Call } from './helpers'

const BASE = 'http://torrserve:8090'
const HASH = 'abcdef0123456789abcdef0123456789abcdef01'
const T = { hash: HASH, title: 'Dune Part Two', stat_string: 'Torrent working', torrent_size: 60e9 }
const FILES = [
  { id: 1, path: 'Dune/Dune.Part.Two.2024.2160p.mkv', length: 58e9 },
  { id: 2, path: 'Dune/sample.nfo', length: 1e3 },
]

const cfg = configOf(torrserve, { baseUrl: BASE, streamUrl: 'http://192.168.1.10:8090/', authMode: 'none' })

function tsServer() {
  return mockFetch(async (c: Call) => {
    if (c.url.pathname === '/echo') return new Response('MatriX.134')
    if (c.url.pathname === '/torrent/upload') return Response.json({ ...T, hash: 'f'.repeat(40) })
    if (c.url.pathname === '/torrents') {
      const body = JSON.parse(String(c.body)) as { action: string; hash?: string; link?: string }
      if (body.action === 'list') return Response.json([T])
      if (body.action === 'get') return Response.json({ ...T, file_stats: FILES })
      if (body.action === 'add') return Response.json({ ...T, hash: 'e'.repeat(40), title: 'Severance' })
      if (body.action === 'rem') return new Response('')
    }
    return new Response('nope', { status: 404 })
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('TorrServe', () => {
  it('test() reads the version from /echo', async () => {
    tsServer()
    expect(await torrserve.test(cfg)).toMatchObject({ ok: true, summary: 'TorrServe MatriX.134', details: ['1 в базе', expect.any(String)] })
  })

  it('adds a magnet with save_to_db via POST /torrents', async () => {
    const calls = tsServer()
    const magnet = `magnet:?xt=urn:btih:${'e'.repeat(40)}`
    const text = await runTool(torrserve, 'torrserve_add', cfg, { result_id: 'r_1', poster: 'https://img.example.com/p.jpg' }, async () => ({ kind: 'magnet', uri: magnet, title: 'Severance S02' }))
    const add = JSON.parse(String(calls.find((c) => c.url.pathname === '/torrents')!.body))
    expect(add).toEqual({ action: 'add', link: magnet, title: 'Severance S02', poster: 'https://img.example.com/p.jpg', save_to_db: true })
    expect(text).toContain('hash eeeeeeee')
  })

  it('uploads a .torrent file for private trackers', async () => {
    const calls = tsServer()
    await runTool(torrserve, 'torrserve_add', cfg, { result_id: 'r_1' }, async () => ({ kind: 'file', data: new Uint8Array([100, 101]), filename: 'x.torrent', title: 'X' }))
    const form = calls.find((c) => c.url.pathname === '/torrent/upload')!.body as FormData
    expect(form.get('file')).toBeInstanceOf(Blob)
    expect(form.get('save')).toBe('true')
  })

  it('builds stream links on the player address, video files only', async () => {
    tsServer()
    const text = await runTool(torrserve, 'torrserve_links', cfg, { hash: 'abcdef01' })
    expect(text).toContain(`Плейлист: http://192.168.1.10:8090/stream/Dune%20Part%20Two.m3u?link=${HASH}&m3u`)
    expect(text).toContain(`http://192.168.1.10:8090/stream/Dune.Part.Two.2024.2160p.mkv?link=${HASH}&index=1&play`)
    expect(text).not.toContain('sample.nfo')
  })

  it('sends basic auth when enabled', async () => {
    const calls = tsServer()
    await torrserve.test(configOf(torrserve, { baseUrl: BASE, authMode: 'basic', username: 'u', password: 'p' }))
    expect(calls[0]!.headers.get('authorization')).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
  })

  it('removes by short hash or name', async () => {
    const calls = tsServer()
    expect(await runTool(torrserve, 'torrserve_remove', cfg, { hash: 'dune' })).toBe('Убрано из TorrServe: Dune Part Two')
    expect(JSON.parse(String(calls.at(-1)!.body))).toEqual({ action: 'rem', hash: HASH })
  })
})
