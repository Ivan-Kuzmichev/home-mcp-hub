import { afterAll, describe, expect, it } from 'vitest'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const journal = await import('@/lib/journal')
const { recordAuthEvent } = await import('@/lib/auth-events')
const { ipInCidr, isValidCidr } = await import('@/lib/net')
const { runCleanup } = await import('@/lib/jobs')
const { getDb } = await import('@/lib/db')
const { toolCall } = await import('@/lib/db/schema')

afterAll(cleanup)

describe('argument redaction', () => {
  it('replaces HTML by its size, hides pins and drops secrets', () => {
    const text = journal.redactArgs({ title: 'Дашборд', html: 'x'.repeat(3000), pin: '4821', password: 'hunter2', api_key: 'k', expires: '7d' })
    expect(text).toBe('title: «Дашборд», html: HTML 3 КБ, pin: задан, expires: 7d')
    expect(text).not.toContain('4821')
    expect(text).not.toContain('hunter2')
  })

  it('scrubs keys inside URLs and cuts to 500 characters', () => {
    expect(journal.redactArgs({ url: 'http://jackett/dl/?jackett_apikey=abc&x=1' })).toBe('url: http://jackett/dl/?jackett_apikey=***&x=1')
    expect(journal.redactArgs({ a: 'y'.repeat(120), b: 'y'.repeat(120), c: 'y'.repeat(120), d: 'y'.repeat(120), e: 'y'.repeat(120) }).length).toBe(500)
    expect(journal.redactArgs({})).toBe('—')
  })
})

describe('journal queries', () => {
  it('filters by connector, status and text; counts errors', () => {
    journal.logToolCall({ tool: 'search_torrents', connectorId: 'jackett', args: { query: 'Dune' }, ok: true, result: 'Найдено 10\nr_1 · …', durationMs: 8400, clientId: 'c1', ip: '160.79.104.5' })
    journal.logToolCall({ tool: 'torrserve_add', connectorId: 'torrserve', args: { result_id: 'r_2' }, ok: false, error: 'TorrServe не ответил за 30 с', durationMs: 30000, clientId: 'c1', ip: '160.79.104.5' })
    expect(journal.countJournal({ periodDays: 7 })).toEqual({ total: 2, errors: 1 })
    expect(journal.queryJournal({ status: 'error' }).map((r) => r.tool)).toEqual(['torrserve_add'])
    expect(journal.queryJournal({ connector: 'jackett' })[0]?.resultSummary).toBe('Найдено 10')
    expect(journal.queryJournal({ q: 'Dune' })).toHaveLength(1)
    expect(journal.lastCallByClient('c1')?.tool).toBe('torrserve_add')
  })

  it('cleanup drops entries older than 30 days', () => {
    getDb().insert(toolCall).values({ tool: 'old', connectorId: 'hub', argsRedacted: '—', ok: true, createdAt: new Date(Date.now() - 31 * 86_400_000) }).run()
    expect(runCleanup().journal).toBe(1)
    expect(journal.queryJournal({}).some((r) => r.tool === 'old')).toBe(false)
  })
})

describe('sign-in events', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).buffer as ArrayBuffer

  it('records failed passwords without the password and successful 2FA with the email', async () => {
    await recordAuthEvent({ method: 'POST', path: '/sign-in/email', body: enc({ email: 'Me@Example.com', password: 'hunter2' }), response: new Response('{}', { status: 401 }), ip: '203.0.113.9' })
    await recordAuthEvent({ method: 'POST', path: '/two-factor/verify-totp', body: enc({ code: '123456' }), response: Response.json({ user: { email: 'me@example.com' } }), ip: '203.0.113.9' })
    const rows = journal.queryJournal({ connector: 'auth' })
    expect(rows.map((r) => [r.tool, r.ok, r.argsRedacted])).toEqual([
      ['auth.second_factor', true, 'me@example.com · TOTP · 203.0.113.9'],
      ['auth.password', false, 'me@example.com · 203.0.113.9'],
    ])
    expect(JSON.stringify(rows)).not.toMatch(/hunter2|123456/)
    expect(journal.failedSignIns(new Date(Date.now() - 60_000))).toBe(1)
  })
})

describe('CIDR', () => {
  it.each([
    ['160.79.104.5', '160.79.104.0/21', true],
    ['160.79.111.255', '160.79.104.0/21', true],
    ['160.79.112.1', '160.79.104.0/21', false],
    ['::ffff:160.79.104.5', '160.79.104.0/21', true],
    ['10.0.0.7', '10.0.0.7', true],
    ['10.0.0.8', '10.0.0.7', false],
  ])('%s in %s → %s', (ip, cidr, expected) => {
    expect(ipInCidr(ip, cidr)).toBe(expected)
  })

  it('validates input', () => {
    expect(isValidCidr('160.79.104.0/21')).toBe(true)
    expect(isValidCidr('160.79.104.0/33')).toBe(false)
    expect(isValidCidr('nope')).toBe(false)
  })
})
