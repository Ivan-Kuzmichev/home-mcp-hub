import { afterEach, describe, expect, it, vi } from 'vitest'
import { MitmClient } from '@/lib/connectors/mitmproxy/client'
import { mockFetch } from './helpers'

const client = () => new MitmClient({ baseUrl: 'http://mitm:8081', password: 'pw-secret', timeoutSec: 5 })

afterEach(() => vi.unstubAllGlobals())

describe('MitmClient', () => {
  it('sends Bearer on GET and parses state', async () => {
    const calls = mockFetch(() => Response.json({ version: '12.3.1', servers: [{ full_spec: 'regular@8080' }, { type: 'wireguard' }] }))
    expect(await client().state()).toEqual({ version: '12.3.1', modes: ['regular@8080', 'wireguard'] })
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer pw-secret')
    expect(calls[0]?.url.pathname).toBe('/state')
  })

  it('falls back to empty modes', async () => {
    mockFetch(() => Response.json({ version: '12.3.1' }))
    expect((await client().state()).modes).toEqual([])
  })

  it('PUT /options sends matching xsrf cookie and header with JSON body', async () => {
    const calls = mockFetch(() => new Response(null, { status: 200 }))
    const c = client()
    await c.setOptions({ hub_mocks: '[]' })
    await c.clear()
    const [put, post] = calls as [(typeof calls)[number], (typeof calls)[number]]
    expect(put.method).toBe('PUT')
    expect(put.url.pathname).toBe('/options')
    expect(put.body).toBe('{"hub_mocks":"[]"}')
    expect(put.headers.get('content-type')).toBe('application/json')
    const token = put.headers.get('x-xsrftoken')
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(put.headers.get('cookie')).toBe(`_mitmproxy_xsrf=${token}`)
    expect(post.method).toBe('POST')
    expect(post.url.pathname).toBe('/clear')
    expect(post.headers.get('x-xsrftoken')).toBe(token)
  })

  it('403 gives a password error without HTML or the password', async () => {
    mockFetch(() => new Response('<html><body>login pw-secret</body></html>', { status: 403 }))
    const err = await client().flows().catch((e: Error) => e)
    expect((err as Error).message).toBe('mitmproxy: неверный пароль веб-интерфейса (403)')
    expect((err as Error).message).not.toContain('<html')
  })

  it('404 on content says the flow is gone', async () => {
    mockFetch(() => new Response('Flow not found.', { status: 404 }))
    await expect(client().content('x', 'response')).rejects.toThrow('Запроса уже нет в mitmproxy — он хранит только последние запросы')
  })

  it('returns raw content bytes', async () => {
    const calls = mockFetch(() => new Response(Buffer.from([1, 2, 3])))
    expect([...(await client().content('abc', 'request'))]).toEqual([1, 2, 3])
    expect(calls[0]?.url.pathname).toBe('/flows/abc/request/content.data')
  })

  it('other errors and network failures', async () => {
    mockFetch(() => new Response('<html>boom</html>', { status: 500, statusText: 'Internal Server Error' }))
    const err = await client().options().catch((e: Error) => e)
    expect((err as Error).message).toBe('mitmproxy: ошибка 500 (Internal Server Error)')
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }))
    await expect(client().flows()).rejects.toThrow(/недоступен.*проверь контейнер mitmweb и адрес в настройках/)
  })
})
