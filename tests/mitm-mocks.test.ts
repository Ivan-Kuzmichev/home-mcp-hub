import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mockFetch, setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { saveConfig, setConnectorEnabled } = await import('@/lib/connectors/store')
const { getConnector } = await import('@/lib/connectors/registry')
const { getDb } = await import('@/lib/db')
const { mitmMock, connector: connectorTable } = await import('@/lib/db/schema')
const { eq } = await import('drizzle-orm')
const { AddonMissingError, deleteAllMocks, deleteMock, listMocks, saveMock, setMockEnabled, syncMocks } = await import('@/lib/connectors/mitmproxy/mocks')

afterAll(cleanup)

const conn = getConnector('mitmproxy')!
const rule = { name: 'x', match: { host: 'api.example.com', path: '/v1/*' }, kind: 'replace' as const, status: 503, body: 'down' }

let options: Record<string, { value: unknown }>
let puts: unknown[]

function proxy(): void {
  puts = []
  mockFetch(({ method, body }) => {
    if (method === 'GET') return Response.json(options)
    const update = JSON.parse(String(body)) as Record<string, unknown>
    puts.push(update)
    options = { ...options, hub_mocks: { value: update.hub_mocks } }
    return new Response(null, { status: 200 })
  })
}

beforeEach(() => {
  getDb().delete(mitmMock).run()
  options = { hub_mocks: { value: '' } }
  saveConfig(conn, { baseUrl: 'http://mitmweb:8081', allowMocks: true })
  setConnectorEnabled('mitmproxy', true)
  proxy()
})

describe('mock storage', () => {
  it('saves, toggles, updates and deletes rules', () => {
    const a = saveMock(rule)
    expect(a.enabled).toBe(true)
    expect(listMocks()).toEqual([a])
    expect(setMockEnabled(a.id, false).enabled).toBe(false)
    const b = saveMock({ ...rule, id: a.id, name: 'renamed' })
    expect(b).toMatchObject({ id: a.id, name: 'renamed', enabled: false })
    deleteMock(a.id)
    expect(listMocks()).toEqual([])
    saveMock(rule)
    saveMock(rule)
    expect(deleteAllMocks()).toBe(2)
  })

  it('refuses an unknown id instead of creating a rule with it', () => {
    expect(() => saveMock({ ...rule, id: 'nope' })).toThrow('Правила nope нет — посмотри mitm_mocks')
    expect(listMocks()).toEqual([])
  })
})

describe('rule order', () => {
  it('lists and pushes rules by creation time, then id', async () => {
    const at = (id: string, ms: number) => getDb().insert(mitmMock).values({
      id, name: id, enabled: true, ruleJson: JSON.stringify({ match: rule.match, kind: 'replace', body: '' }),
      createdAt: new Date(ms), updatedAt: new Date(ms),
    }).run()
    at('zzz', 1000)
    at('bbb', 2000)
    at('aaa', 2000)
    at('mmm', 500)
    expect(listMocks().map((r) => r.id)).toEqual(['mmm', 'zzz', 'aaa', 'bbb'])
    await syncMocks()
    const sent = JSON.parse((puts[0] as { hub_mocks: string }).hub_mocks) as { rules: { id: string }[] }
    expect(sent.rules.map((r) => r.id)).toEqual(['mmm', 'zzz', 'aaa', 'bbb'])
  })
})

describe('syncMocks', () => {
  it('pushes once, then is in sync', async () => {
    saveMock(rule)
    expect(await syncMocks()).toBe('pushed')
    expect(await syncMocks()).toBe('in-sync')
    expect(puts).toHaveLength(1)
  })

  it('pushes again after the proxy restarts', async () => {
    saveMock(rule)
    await syncMocks()
    options = { hub_mocks: { value: '' } }
    expect(await syncMocks()).toBe('pushed')
    expect(puts[1]).toEqual(puts[0])
  })

  it('pushes an empty list when the connector is off', async () => {
    saveMock(rule)
    await syncMocks()
    setConnectorEnabled('mitmproxy', false)
    expect(await syncMocks()).toBe('pushed')
    expect(puts[1]).toEqual({ hub_mocks: '{"rules":[]}' })
  })

  it('pushes an empty list when allowMocks is off', async () => {
    saveMock(rule)
    saveConfig(conn, { baseUrl: 'http://mitmweb:8081', allowMocks: false })
    expect(await syncMocks()).toBe('pushed')
    expect(puts[0]).toEqual({ hub_mocks: '{"rules":[]}' })
  })

  it('reports a missing addon', async () => {
    options = {}
    await expect(syncMocks({ strict: true })).rejects.toBeInstanceOf(AddonMissingError)
    expect(await syncMocks()).toBe('skipped')
  })

  it('skips without a connector row', async () => {
    getDb().delete(connectorTable).where(eq(connectorTable.id, 'mitmproxy')).run()
    expect(await syncMocks()).toBe('skipped')
  })

  it('leaves disabled rules out of the payload', async () => {
    const a = saveMock(rule)
    saveMock({ ...rule, name: 'on' })
    setMockEnabled(a.id, false)
    await syncMocks()
    const sent = JSON.parse((puts[0] as { hub_mocks: string }).hub_mocks) as { rules: { name: string }[] }
    expect(sent.rules.map((r) => r.name)).toEqual(['on'])
  })

  it('throws on network errors only in strict mode', async () => {
    saveMock(rule)
    mockFetch(() => {
      throw new TypeError('fetch failed')
    })
    expect(await syncMocks()).toBe('skipped')
    await expect(syncMocks({ strict: true })).rejects.toThrow()
  })
})
