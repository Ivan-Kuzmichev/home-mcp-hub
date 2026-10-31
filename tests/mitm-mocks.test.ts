import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mockFetch, setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { saveConfig, setConnectorEnabled } = await import('@/lib/connectors/store')
const { getConnector } = await import('@/lib/connectors/registry')
const { getDb } = await import('@/lib/db')
const { mitmMock, connector: connectorTable } = await import('@/lib/db/schema')
const { eq } = await import('drizzle-orm')
const { getSetting } = await import('@/lib/settings')
const { mutateMocks } = await import('@/lib/connectors/mitmproxy/mocks')
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
    expect(puts[1]).toEqual({ hub_mocks: '{"allowed":false,"rules":[]}' })
  })

  it('pushes an empty list when allowMocks is off', async () => {
    saveMock(rule)
    saveConfig(conn, { baseUrl: 'http://mitmweb:8081', allowMocks: false })
    expect(await syncMocks()).toBe('pushed')
    expect(puts[0]).toEqual({ hub_mocks: '{"allowed":false,"rules":[]}' })
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

  it('sends disabled rules too, flagged, with allowed', async () => {
    const a = saveMock(rule)
    saveMock({ ...rule, name: 'on' })
    setMockEnabled(a.id, false)
    await syncMocks()
    const sent = JSON.parse((puts[0] as { hub_mocks: string }).hub_mocks) as { allowed: boolean; rules: { name: string; enabled: boolean }[] }
    expect(sent.allowed).toBe(true)
    // Same createdAt: the order between the two depends on the random ids.
    expect(Object.fromEntries(sent.rules.map((r) => [r.name, r.enabled]))).toEqual({ x: false, on: true })
  })

  it('runs one at a time so an older push never lands after a newer one', async () => {
    let gets = 0
    puts = []
    mockFetch(async ({ method, body }) => {
      if (method === 'GET') {
        // The first (cron) read is slow, the second (tool) read is fast.
        if (gets++ === 0) await new Promise((r) => setTimeout(r, 30))
        return Response.json(options)
      }
      const update = JSON.parse(String(body)) as Record<string, unknown>
      puts.push(update)
      options = { ...options, hub_mocks: { value: update.hub_mocks } }
      return new Response(null, { status: 200 })
    })
    options = { hub_mocks: { value: 'stale' } }
    const cron = syncMocks()
    await Promise.resolve()
    saveMock(rule)
    const tool = syncMocks({ strict: true })
    await Promise.all([cron, tool])
    const final = JSON.parse(String(options.hub_mocks!.value)) as { rules: unknown[] }
    expect(final.rules).toHaveLength(1)
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

describe('edits from mitmweb', () => {
  type Edit = { seq: number; op: 'enable' | 'disable' | 'delete'; id: string }
  const journal = (epoch: string, edits: Edit[]) => {
    options = { ...options, hub_mocks_edits: { value: JSON.stringify({ epoch, edits }) } }
  }
  const enabledOf = () => Object.fromEntries(listMocks().map((r) => [r.id, r.enabled]))

  it('applies each edit once and pushes the result', async () => {
    const a = saveMock(rule)
    const b = saveMock({ ...rule, name: 'b' })
    journal('e1', [{ seq: 1, op: 'disable', id: a.id }, { seq: 2, op: 'delete', id: b.id }])
    expect(await syncMocks()).toBe('pushed')
    expect(enabledOf()).toEqual({ [a.id]: false })
    expect(JSON.parse(getSetting('mitm_edits_cursor')!)).toEqual({ epoch: 'e1', lastSeq: 2 })
    // The same journal again changes nothing: a rule enabled since then stays enabled.
    setMockEnabled(a.id, true)
    await syncMocks()
    expect(enabledOf()).toEqual({ [a.id]: true })
    // Only newer edits apply.
    journal('e1', [{ seq: 1, op: 'disable', id: a.id }, { seq: 2, op: 'delete', id: b.id }, { seq: 3, op: 'disable', id: a.id }])
    await syncMocks()
    expect(enabledOf()).toEqual({ [a.id]: false })
  })

  it('applies all edits again under a new epoch', async () => {
    const a = saveMock(rule)
    journal('e1', [{ seq: 1, op: 'disable', id: a.id }])
    await syncMocks()
    setMockEnabled(a.id, true)
    journal('e2', [{ seq: 1, op: 'disable', id: a.id }])
    await syncMocks()
    expect(enabledOf()).toEqual({ [a.id]: false })
    expect(JSON.parse(getSetting('mitm_edits_cursor')!)).toEqual({ epoch: 'e2', lastSeq: 1 })
  })

  it('ignores unknown ids and broken journals', async () => {
    const a = saveMock(rule)
    journal('e3', [{ seq: 1, op: 'enable', id: 'nope' }, { seq: 2, op: 'delete', id: 'gone' }, { seq: 3, op: 'disable', id: a.id }])
    expect(await syncMocks({ strict: true })).toBe('pushed')
    expect(enabledOf()).toEqual({ [a.id]: false })
    options = { ...options, hub_mocks_edits: { value: 'garbage' } }
    expect(await syncMocks({ strict: true })).toBe('in-sync')
  })

  it('ignores edits but advances the cursor while allowMocks is off', async () => {
    const a = saveMock(rule)
    saveConfig(conn, { baseUrl: 'http://mitmweb:8081', allowMocks: false })
    journal('e4', [{ seq: 1, op: 'delete', id: a.id }])
    await syncMocks()
    expect(enabledOf()).toEqual({ [a.id]: true })
    expect(JSON.parse(getSetting('mitm_edits_cursor')!)).toEqual({ epoch: 'e4', lastSeq: 1 })
    saveConfig(conn, { baseUrl: 'http://mitmweb:8081', allowMocks: true })
    await syncMocks()
    expect(enabledOf()).toEqual({ [a.id]: true })
  })

  it('never clears the addon journal', async () => {
    const a = saveMock(rule)
    journal('e5', [{ seq: 1, op: 'disable', id: a.id }])
    await syncMocks()
    expect(puts.every((p) => !('hub_mocks_edits' in (p as object)))).toBe(true)
  })
})

describe('mutateMocks', () => {
  it('applies pending mitmweb edits first, then the change, then pushes once', async () => {
    const a = saveMock(rule)
    options = { ...options, hub_mocks_edits: { value: JSON.stringify({ epoch: 'mut1', edits: [{ seq: 1, op: 'disable', id: a.id }] }) } }
    const res = await mutateMocks(() => setMockEnabled(a.id, true))
    expect(res).toMatchObject({ value: { id: a.id, enabled: true }, failure: null })
    expect(puts).toHaveLength(1)
    expect(listMocks()[0]!.enabled).toBe(true)
  })

  it('a failing change propagates and pushes nothing', async () => {
    await expect(mutateMocks(() => setMockEnabled('nope', true))).rejects.toThrow('Правила nope нет — посмотри mitm_mocks')
    expect(puts).toHaveLength(0)
  })

  it('reports a failed push as failure after storing the change', async () => {
    options = {}
    const res = await mutateMocks(() => saveMock(rule))
    expect(res.failure).toContain('hub_mocks.py')
    expect(listMocks()).toHaveLength(1)
  })
})
