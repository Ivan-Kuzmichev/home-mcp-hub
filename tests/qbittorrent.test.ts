import { afterEach, describe, expect, it, vi } from 'vitest'
import { qbittorrent } from '@/lib/connectors/qbittorrent'
import { pickSessionCookie } from '@/lib/connectors/qbittorrent/client'
import { configOf, formBody, mockFetch, runTool, type Call } from './helpers'

const BASE = 'http://qbittorrent:8080'
const T1 = { hash: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555', name: 'Severance.S02.1080p.WEB-DL', state: 'downloading', progress: 0.62, dlspeed: 8_800_000, upspeed: 0, eta: 840, num_seeds: 45, num_complete: 120, size: 20e9, category: 'claude', added_on: 2 }
const T2 = { hash: 'ffff9999aaaa0000bbbb1111cccc2222dddd3333', name: 'Dune.Part.Two.2024.2160p', state: 'stoppedDL', progress: 0.18, dlspeed: 0, upspeed: 0, eta: 8640000, num_seeds: 3, num_complete: 10, size: 60e9, category: 'claude', added_on: 1 }

const none = configOf(qbittorrent, { baseUrl: `${BASE}/`, authMode: 'none', defaultCategory: 'claude' })

function qbServer(extra: (c: Call) => Response | undefined = () => undefined) {
  return mockFetch((c) => {
    const custom = extra(c)
    if (custom) return custom
    const p = c.url.pathname
    if (p === '/api/v2/app/version') return new Response('v5.2.3')
    if (p === '/api/v2/app/webapiVersion') return new Response('2.15.1')
    if (p === '/api/v2/transfer/info') return Response.json({ dl_info_speed: 1, up_info_speed: 0, connection_status: 'connected', dht_nodes: 5 })
    if (p === '/api/v2/sync/maindata') return Response.json({ server_state: { free_space_on_disk: 4e11 } })
    if (p === '/api/v2/torrents/info') {
      const hashes = c.url.searchParams.get('hashes')?.split('|')
      return Response.json([T1, T2].filter((t) => !hashes || hashes.includes(t.hash)))
    }
    if (['/api/v2/torrents/stop', '/api/v2/torrents/start', '/api/v2/torrents/delete', '/api/v2/torrents/add'].includes(p)) return new Response('Ok.')
    return new Response('Not Found', { status: 404 })
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('qBittorrent config', () => {
  it('requires credentials for the chosen auth mode', () => {
    expect(qbittorrent.parseConfig({ baseUrl: BASE, authMode: 'apikey' })).toMatchObject({ ok: false, errors: { apiKey: expect.any(String) } })
    expect(qbittorrent.parseConfig({ baseUrl: BASE, authMode: 'password', username: 'admin' })).toMatchObject({ ok: false, errors: { password: expect.any(String) } })
    expect(qbittorrent.parseConfig({ baseUrl: 'not a url', authMode: 'none' })).toMatchObject({ ok: false, errors: { baseUrl: expect.any(String) } })
  })
})

describe('qBittorrent auth', () => {
  it('logs in once with Referer, uses the QBT_SID_<port> cookie and re-logs in when it expires', async () => {
    let logins = 0
    let valid = ''
    const calls = qbServer((c) => {
      if (c.url.pathname === '/api/v2/auth/login') {
        logins++
        valid = `sid${logins}`
        return new Response('Ok.', { headers: [['set-cookie', `QBT_SID_8080=${valid}; HttpOnly; SameSite=Strict; path=/`]] })
      }
      if (c.headers.get('cookie') !== `QBT_SID_8080=${valid}`) return new Response('Forbidden', { status: 403 })
      return undefined
    })
    const cfg = configOf(qbittorrent, { baseUrl: 'http://qb-login:8080', authMode: 'password', username: 'admin', password: 'secret' })

    // Three parallel requests share one login.
    expect(await qbittorrent.test(cfg)).toMatchObject({ ok: true, version: 'v5.2.3' })
    expect(logins).toBe(1)
    const login = calls.find((c) => c.url.pathname === '/api/v2/auth/login')!
    expect(login.headers.get('referer')).toBe('http://qb-login:8080')
    expect(formBody(login).get('username')).toBe('admin')

    // Session expires on the server: one new login, then success.
    valid = 'expired'
    expect(await runTool(qbittorrent, 'transfer_info', cfg).catch((e: Error) => e.message)).not.toContain('нет доступа')
    expect(logins).toBe(2)
  })

  it('reports wrong credentials', async () => {
    qbServer((c) => (c.url.pathname === '/api/v2/auth/login' ? new Response('Fails.') : undefined))
    const cfg = configOf(qbittorrent, { baseUrl: 'http://qb-bad:8080', authMode: 'password', username: 'a', password: 'b' })
    expect(await qbittorrent.test(cfg)).toMatchObject({ ok: false, summary: expect.stringContaining('неверный логин') })
  })

  it('sends the API key as a bearer token', async () => {
    const calls = qbServer()
    await qbittorrent.test(configOf(qbittorrent, { baseUrl: BASE, authMode: 'apikey', apiKey: 'k123' }))
    expect(calls.every((c) => c.headers.get('authorization') === 'Bearer k123')).toBe(true)
  })

  it('picks the session cookie by name', () => {
    expect(pickSessionCookie(['other=1; path=/', 'QBT_SID_8080=abc; HttpOnly'])).toBe('QBT_SID_8080=abc')
    expect(pickSessionCookie(['SID=xyz; HttpOnly'])).toBe('SID=xyz')
  })
})

describe('qBittorrent tools', () => {
  it('torrents_status lists progress, speed, eta and short hash', async () => {
    const calls = qbServer()
    const text = await runTool(qbittorrent, 'torrents_status', none, { filter: 'all' })
    expect(calls[0]!.url.searchParams.get('filter')).toBe('all')
    expect(text).toContain('2 торрента (все)')
    expect(text).toContain('Severance.S02.1080p.WEB-DL — 62% · ↓ 8,4 МБ/с · осталось 14 мин')
    expect(text).toContain('hash aaaa1111')
    expect(text).toContain('остановлен')
  })

  it('torrent_stop uses the 5.x stop endpoint and resolves short hashes', async () => {
    const calls = qbServer()
    const text = await runTool(qbittorrent, 'torrent_stop', none, { hashes: ['aaaa1111'] })
    const stop = calls.find((c) => c.url.pathname === '/api/v2/torrents/stop')!
    expect(formBody(stop).get('hashes')).toBe(T1.hash)
    expect(calls.some((c) => c.url.pathname.includes('pause'))).toBe(false)
    expect(text).toBe('Остановлено: Severance.S02.1080p.WEB-DL')
  })

  it('torrent_start accepts "all"', async () => {
    const calls = qbServer()
    await runTool(qbittorrent, 'torrent_start', none, { hashes: ['all'] })
    expect(formBody(calls.find((c) => c.url.pathname === '/api/v2/torrents/start')!).get('hashes')).toBe('all')
  })

  it('explains ambiguous and unknown references', async () => {
    qbServer()
    await expect(runTool(qbittorrent, 'torrent_stop', none, { hashes: ['zzzz'] })).rejects.toThrow('не найден')
    await expect(runTool(qbittorrent, 'torrent_stop', none, { hashes: ['.'] })).rejects.toThrow('нескольким')
  })

  it('torrent_add by result_id sends the magnet with `stopped` and the default category', async () => {
    const calls = qbServer()
    const magnet = 'magnet:?xt=urn:btih:1234567890abcdef1234567890abcdef12345678&dn=x'
    const text = await runTool(qbittorrent, 'torrent_add', none, { result_id: 'r_abcde', stopped: true }, async () => ({ kind: 'magnet', uri: magnet, title: 'Severance S02' }))
    const add = calls.find((c) => c.url.pathname === '/api/v2/torrents/add')!
    const form = add.body as FormData
    expect(form.get('urls')).toBe(magnet)
    expect(form.get('stopped')).toBe('true')
    expect(form.has('paused')).toBe(false)
    expect(form.get('category')).toBe('claude')
    expect(text).toBe('Добавлено: Severance S02 · категория claude · остановлен · hash 12345678')
  })

  it('torrent_add uploads a .torrent file for private trackers', async () => {
    const calls = qbServer()
    const data = new TextEncoder().encode('d4:infod4:name1:xee')
    await runTool(qbittorrent, 'torrent_add', none, { result_id: 'r_x' }, async () => ({ kind: 'file', data, filename: 'x.torrent', title: 'X' }))
    const file = (calls.find((c) => c.url.pathname === '/api/v2/torrents/add')!.body as FormData).get('torrents')
    expect(file).toBeInstanceOf(Blob)
  })

  it('torrent_add reports a torrent that is already there', async () => {
    const calls = qbServer()
    const text = await runTool(qbittorrent, 'torrent_add', none, { url: `magnet:?xt=urn:btih:${T1.hash}` })
    expect(text).toContain('Уже в списке')
    expect(calls.some((c) => c.url.pathname === '/api/v2/torrents/add')).toBe(false)
  })

  it('torrent_delete with files needs confirm: true', async () => {
    const calls = qbServer()
    const refused = await runTool(qbittorrent, 'torrent_delete', none, { hashes: ['ffff9999'], delete_files: true })
    expect(refused).toContain('confirm: true')
    expect(calls.some((c) => c.url.pathname === '/api/v2/torrents/delete')).toBe(false)

    await runTool(qbittorrent, 'torrent_delete', none, { hashes: ['ffff9999'], delete_files: true, confirm: true })
    const del = formBody(calls.find((c) => c.url.pathname === '/api/v2/torrents/delete')!)
    expect(del.get('hashes')).toBe(T2.hash)
    expect(del.get('deleteFiles')).toBe('true')
  })

  it('marks tools with read-only / destructive hints', () => {
    const hints = Object.fromEntries(qbittorrent.tools.map((t) => [t.name, t.annotations]))
    expect(hints.torrents_status?.readOnlyHint).toBe(true)
    expect(hints.transfer_info?.readOnlyHint).toBe(true)
    expect(hints.torrent_delete?.destructiveHint).toBe(true)
  })

  it('turns a refused connection into a short message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))))
    expect(await qbittorrent.test(none)).toMatchObject({ ok: false, summary: 'qBittorrent недоступен: соединение отклонено' })
  })
})
