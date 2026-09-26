import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONNECTORS } from '@/lib/connectors/registry'
import { transmission } from '@/lib/connectors/transmission'
import { configOf, mockFetch, runTool, type Call } from './helpers'

const BASE = 'http://transmission:9091'
const H1 = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555'
const H2 = 'ffff9999aaaa0000bbbb1111cccc2222dddd3333'
const T = (over: Record<string, unknown>) => ({
  id: 1, hashString: H1, name: 'Severance.S02.1080p', status: 4, percentDone: 0.62, rateDownload: 8_800_000, rateUpload: 0, eta: 840,
  peersSendingToUs: 12, peersConnected: 40, totalSize: 20e9, error: 0, errorString: '', labels: ['claude'], addedDate: 2, ...over,
})
const TORRENTS = [T({}), T({ id: 2, hashString: H2, name: 'Dune.Part.Two.2160p', status: 0, percentDone: 1, rateDownload: 0, addedDate: 1, labels: [] })]

const cfg = configOf(transmission, { baseUrl: BASE, authMode: 'none', defaultLabel: 'claude' })

type Rpc = { method: string; arguments: Record<string, unknown> }
function trServer(onRpc: (r: Rpc) => unknown = () => ({}), sessionId = 'sid-1') {
  const rpcs: Rpc[] = []
  const calls = mockFetch((c: Call) => {
    if (c.url.pathname !== '/transmission/rpc') return new Response('nope', { status: 404 })
    if (c.headers.get('x-transmission-session-id') !== sessionId) return new Response('', { status: 409, headers: { 'X-Transmission-Session-Id': sessionId } })
    const r = JSON.parse(String(c.body)) as Rpc
    rpcs.push(r)
    const custom = onRpc(r)
    if (r.method === 'session-get') return Response.json({ result: 'success', arguments: { version: '4.0.6 (38c164933e)', 'rpc-version': 17, 'download-dir': '/downloads' } })
    if (r.method === 'torrent-get' && !(r.arguments.fields as string[]).includes('files')) return Response.json({ result: 'success', arguments: { torrents: TORRENTS } })
    if (r.method === 'torrent-get') return Response.json({ result: 'success', arguments: { torrents: [{ name: 'Severance.S02.1080p', files: [{ name: 'S02/E01.mkv', length: 2e9, bytesCompleted: 1e9 }], wanted: [1] }] } })
    if (r.method === 'free-space') return Response.json({ result: 'success', arguments: { 'size-bytes': 4e11 } })
    if (r.method === 'session-stats') return Response.json({ result: 'success', arguments: { downloadSpeed: 1e6, uploadSpeed: 0, activeTorrentCount: 1, torrentCount: 2 } })
    return Response.json({ result: 'success', arguments: custom ?? {} })
  })
  return { calls, rpcs }
}

afterEach(() => vi.unstubAllGlobals())

describe('Transmission', () => {
  it('does the 409 session-id handshake and reports the version', async () => {
    const { calls } = trServer()
    expect(await transmission.test(cfg)).toMatchObject({ ok: true, summary: 'Transmission 4.0.6', details: ['RPC 17', '2 торрента', expect.any(String)] })
    expect(calls[0]!.headers.get('x-transmission-session-id')).toBeNull()
    expect(calls.at(-1)!.headers.get('x-transmission-session-id')).toBe('sid-1')
  })

  it('sends basic auth when enabled and explains a 401', async () => {
    const calls = mockFetch(() => new Response('', { status: 401 }))
    const basic = configOf(transmission, { baseUrl: 'http://tr-auth:9091', authMode: 'basic', username: 'u', password: 'p' })
    expect(await transmission.test(basic)).toMatchObject({ ok: false, summary: 'Transmission: неверный логин или пароль' })
    expect(calls[0]!.headers.get('authorization')).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
  })

  it('transmission_status formats progress and filters', async () => {
    trServer()
    const text = await runTool(transmission, 'transmission_status', cfg, { filter: 'all' })
    expect(text).toContain('2 торрента (все)')
    expect(text).toContain('Severance.S02.1080p — 62% · ↓ 8,4 МБ/с · осталось 14 мин · пиры 12/40')
    expect(text).toContain('Dune.Part.Two.2160p — 100% · пиры 12/40 · 18,6 ГБ · готов')
    expect(await runTool(transmission, 'transmission_status', cfg, { filter: 'downloading' })).toContain('1 торрент (качаются)')
  })

  it('adds a magnet with the default label, and a .torrent as metainfo', async () => {
    const { rpcs } = trServer((r) => (r.method === 'torrent-add' ? { 'torrent-added': { hashString: H1, name: 'Severance' } } : undefined))
    const magnet = `magnet:?xt=urn:btih:${H1}`
    const text = await runTool(transmission, 'transmission_add', cfg, { result_id: 'r_1', paused: true }, async () => ({ kind: 'magnet', uri: magnet, title: 'Severance S02' }))
    expect(rpcs.at(-1)).toEqual({ method: 'torrent-add', arguments: { filename: magnet, paused: true, labels: ['claude'] } })
    expect(text).toBe('Добавлено: Severance S02 · метка claude · остановлен · hash aaaa1111')

    const data = new TextEncoder().encode('d4:infod4:name1:xee')
    await runTool(transmission, 'transmission_add', cfg, { result_id: 'r_2' }, async () => ({ kind: 'file', data, filename: 'x.torrent', title: 'X' }))
    expect(rpcs.at(-1)!.arguments.metainfo).toBe(Buffer.from(data).toString('base64'))
  })

  it('reports a duplicate instead of adding twice', async () => {
    trServer((r) => (r.method === 'torrent-add' ? { 'torrent-duplicate': { hashString: H1, name: 'Severance.S02.1080p' } } : undefined))
    expect(await runTool(transmission, 'transmission_add', cfg, { url: `magnet:?xt=urn:btih:${H1}` })).toBe('Уже в списке: Severance.S02.1080p · hash aaaa1111')
  })

  it('stops by short hash, starts all, and needs confirm to delete files', async () => {
    const { rpcs } = trServer()
    expect(await runTool(transmission, 'transmission_stop', cfg, { hashes: ['aaaa1111'] })).toBe('Остановлено: Severance.S02.1080p')
    expect(rpcs.at(-1)).toEqual({ method: 'torrent-stop', arguments: { ids: [H1] } })
    await runTool(transmission, 'transmission_start', cfg, { hashes: ['all'] })
    expect(rpcs.at(-1)).toEqual({ method: 'torrent-start', arguments: {} })

    expect(await runTool(transmission, 'transmission_delete', cfg, { hashes: ['dune'], delete_files: true })).toContain('confirm: true')
    expect(rpcs.some((r) => r.method === 'torrent-remove')).toBe(false)
    await runTool(transmission, 'transmission_delete', cfg, { hashes: ['dune'], delete_files: true, confirm: true })
    expect(rpcs.at(-1)).toEqual({ method: 'torrent-remove', arguments: { ids: [H2], 'delete-local-data': true } })
  })

  it('lists files and transfer info', async () => {
    trServer()
    expect(await runTool(transmission, 'transmission_files', cfg, { hash: 'aaaa' })).toContain('E01.mkv — 50% · 1,9 ГБ')
    expect(await runTool(transmission, 'transmission_info', cfg)).toBe('↓ 976,6 КБ/с · ↑ 0\nАктивных: 1 из 2\nСвободно на диске: 372,5 ГБ')
  })
})

describe('registry', () => {
  it('has globally unique tool names', () => {
    const names = CONNECTORS.flatMap((c) => c.tools.map((t) => t.name))
    expect(new Set(names).size).toBe(names.length)
    expect(names).not.toContain('hub_status')
  })
})
