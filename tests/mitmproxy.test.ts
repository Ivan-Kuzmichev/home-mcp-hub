import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { configOf, mockFetch, runTool, setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { mitmproxy } = await import('@/lib/connectors/mitmproxy')
const { appOf } = await import('@/lib/connectors/mitmproxy/flows')
const { saveMock } = await import('@/lib/connectors/mitmproxy/mocks')
const { getDb } = await import('@/lib/db')
const { mitmMock } = await import('@/lib/db/schema')

afterAll(cleanup)

const cfg = (extra: Record<string, unknown> = {}) => configOf(mitmproxy, extra)
const now = () => Date.now() / 1000
const UA = 'Bank/5.1 CFNetwork/1568 Darwin/24.0.0'

type F = Record<string, unknown>
function flow(id: string, host: string, path: string, o: F = {}): F {
  return {
    id,
    type: 'http',
    comment: '',
    timestamp_created: now() - 60,
    request: { method: 'GET', scheme: 'https', host, port: 443, path, headers: [['User-Agent', UA]], contentLength: 0, timestamp_start: now() },
    response: { status_code: 200, headers: [['Content-Type', 'application/json']], contentLength: 1024 },
    ...o,
  }
}

const FLOWS: F[] = [
  flow('aaaaaaaa-1111', 'api.bank.example', '/v1/me?token=abc12345secret'),
  flow('bbbbbbbb-2222', 'api.bank.example', '/v1/cards', { response: { status_code: 404, headers: [], contentLength: 10 } }),
  flow('cccccccc-3333', 'cdn.bank.example', '/logo.png'),
  flow('dddddddd-4444', 'news.example', '/', {
    request: { method: 'GET', scheme: 'https', host: 'news.example', port: 443, path: '/', headers: [['User-Agent', 'Mozilla/5.0 (Macintosh)']], contentLength: 0, timestamp_start: now() },
  }),
  flow('eeeeeeee-5555', 'down.example', '/x', { response: undefined, error: { msg: 'Connection refused' } }),
  flow('ffffffff-6666', 'api.mocked.example', '/m', { comment: 'mock:m1' }),
  flow('99999999-0000', 'old.example', '/', { timestamp_created: now() - 3600 }),
  flow('12121212-3434', 'big.example', '/video', { response: { status_code: 200, headers: [['Content-Length', '5000000']], contentLength: null } }),
]

const BODIES: Record<string, Buffer> = {
  'aaaaaaaa-1111/response': Buffer.from(JSON.stringify({ name: 'Ivan', refresh_token: 'rt-very-secret-value' })),
  'cccccccc-3333/response': Buffer.from([0xff, 0xfe, 0x00, 0x01]),
}

beforeEach(() => {
  getDb().delete(mitmMock).run()
  mockFetch(({ url }) => {
    const p = url.pathname
    if (p === '/state') return Response.json({ version: '12.3.1', servers: [{ full_spec: 'regular' }, { full_spec: 'socks5' }] })
    if (p === '/flows') return Response.json(FLOWS)
    if (p === '/options') return Response.json({ hub_mocks: { value: '' } })
    const m = /^\/flows\/(.+)\/(request|response)\/content\.data$/.exec(p)
    if (m) {
      const b = BODIES[`${m[1]}/${m[2]}`]
      return b ? new Response(new Uint8Array(b)) : new Response(null, { status: 404 })
    }
    return new Response('nope', { status: 500 })
  })
})

describe('appOf', () => {
  it('takes the app name from User-Agent', () => {
    expect(appOf(FLOWS[0] as never)).toBe('Bank')
    expect(appOf(FLOWS[3] as never)).toBe('Mozilla')
    expect(appOf(flow('x', 'h', '/', { request: { method: 'GET', scheme: 'https', host: 'h', port: 1, path: '/', headers: [], contentLength: 0, timestamp_start: 0 } }) as never)).toBe('?')
  })
})

describe('mitm_hosts', () => {
  it('groups by host and sorts by count', async () => {
    const out = await runTool(mitmproxy, 'mitm_hosts', cfg())
    expect(out).toContain('За 15 мин: 6 доменов, 7 запросов')
    const lines = out.split('\n')
    expect(lines[1]).toMatch(/^• api\.bank\.example — 2 запр\. · .*2xx 1 \/ 4xx 1/)
    expect(out).toContain('ошибка 1')
    expect(out).not.toContain('old.example')
  })

  it('filters by app without case and by minutes', async () => {
    const out = await runTool(mitmproxy, 'mitm_hosts', cfg(), { app: 'bank' })
    expect(out).toContain('api.bank.example')
    expect(out).toContain('cdn.bank.example')
    expect(out).not.toContain('news.example')
    expect(await runTool(mitmproxy, 'mitm_hosts', cfg(), { minutes: 120 })).toContain('old.example')
  })
})

describe('mitm_flows', () => {
  it('lists with short ids, masks the url and shows the mock name', async () => {
    saveMock({ id: 'm1', name: 'Банк недоступен', match: { host: 'api.mocked.example', path: '/*' }, kind: 'replace', status: 503, body: 'x' })
    const out = await runTool(mitmproxy, 'mitm_flows', cfg(), { host: 'bank' })
    expect(out).toMatch(/• aaaaaaaa · GET api\.bank\.example\/v1\/me\?token=/)
    expect(out).not.toContain('abc12345secret')
    expect(await runTool(mitmproxy, 'mitm_flows', cfg(), { host: 'mocked' })).toContain('мок «Банк недоступен»')
    expect(await runTool(mitmproxy, 'mitm_flows', cfg({ showTokens: true }), { host: 'bank' })).toContain('abc12345secret')
  })
})

describe('mitm_flow', () => {
  it('masks tokens by default and resolves a short id', async () => {
    const out = await runTool(mitmproxy, 'mitm_flow', cfg(), { id: 'aaaaaaaa' })
    expect(out).toContain('Ivan')
    expect(out).not.toContain('rt-very-secret-value')
    expect(out).not.toContain('abc12345secret')
  })

  it('masks the Authorization header', async () => {
    FLOWS[0] = flow('aaaaaaaa-1111', 'api.bank.example', '/v1/me', {
      request: { method: 'GET', scheme: 'https', host: 'api.bank.example', port: 443, path: '/v1/me', headers: [['Authorization', 'Bearer supersecrettokenvalue123']], contentLength: 0, timestamp_start: 0 },
    })
    const masked = await runTool(mitmproxy, 'mitm_flow', cfg(), { id: 'aaaaaaaa-1111' })
    expect(masked).not.toContain('supersecrettokenvalue123')
    const raw = await runTool(mitmproxy, 'mitm_flow', cfg({ showTokens: true }), { id: 'aaaaaaaa-1111' })
    expect(raw).toContain('supersecrettokenvalue123')
    expect(raw).toContain('rt-very-secret-value')
  })

  it('reports binary and streamed bodies', async () => {
    expect(await runTool(mitmproxy, 'mitm_flow', cfg(), { id: 'cccccccc' })).toContain('бинарное, 4 байт')
    expect(await runTool(mitmproxy, 'mitm_flow', cfg(), { id: '12121212' })).toContain('тело не сохранено (больше 1 МБ, стрим)')
  })

  it('pages long output by offset and rejects unknown ids', async () => {
    const out = await runTool(mitmproxy, 'mitm_flow', cfg({ textLimit: 2000 }), { id: 'aaaaaaaa' })
    expect(out.length).toBeLessThan(2100)
    BODIES['aaaaaaaa-1111/response'] = Buffer.from('x'.repeat(5000))
    const long = await runTool(mitmproxy, 'mitm_flow', cfg({ textLimit: 2000 }), { id: 'aaaaaaaa' })
    expect(long).toMatch(/… \(offset для продолжения: 2000\)/)
    await expect(runTool(mitmproxy, 'mitm_flow', cfg(), { id: 'zzzzzzzz' })).rejects.toThrow(/уже нет/)
  })
})

describe('mitm_status, test, hiddenTools', () => {
  it('status line', async () => {
    saveMock({ name: 'a', match: { host: 'a.example', path: '/*' }, kind: 'replace', status: 500, body: '' })
    expect(await runTool(mitmproxy, 'mitm_status', cfg())).toBe(
      'mitmproxy 12.3.1 · режимы regular, socks5 · в памяти 8 запросов · аддон hub_mocks подключён · правил активно 1',
    )
  })

  it('hides mock tools unless allowMocks', () => {
    expect(mitmproxy.hiddenTools!(cfg())).toEqual(['mitm_mock_replace', 'mitm_mock_patch', 'mitm_mocks', 'mitm_mock_toggle', 'mitm_mock_delete', 'mitm_clear'])
    expect(mitmproxy.hiddenTools!(cfg({ allowMocks: true }))).toEqual([])
  })

  it('test() reports version and a missing addon', async () => {
    const ok = await mitmproxy.test(cfg())
    expect(ok).toMatchObject({ ok: true, summary: 'mitmproxy 12.3.1' })
    expect(ok.details).toContain('аддон hub_mocks: подключён')
    mockFetch(({ url }) => {
      if (url.pathname === '/state') return Response.json({ version: '12.3.1', servers: [] })
      if (url.pathname === '/flows') return Response.json([])
      return Response.json({})
    })
    const missing = await mitmproxy.test(cfg())
    expect(missing.details).toContain('аддон hub_mocks: не подключён')
    expect(missing.details).toContain('в памяти 0 запросов')
  })
})
