import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configOf, mockFetch, runTool, runToolRaw, setupTempDb, type Call } from './helpers'

const cleanup = await setupTempDb()
process.env.BASE_URL = 'https://hub.example.com'
const { papra } = await import('@/lib/connectors/papra')
const { createLink, purgeOldPapraChanges } = await import('@/lib/connectors/papra/logic')
const { saveConfig } = await import('@/lib/connectors/store')
const route = await import('@/app/f/[token]/route')

afterAll(cleanup)
afterEach(() => vi.unstubAllGlobals())

const BASE = 'http://papra:1221'
const ORG = 'org_home'
const API = `/api/organizations/${ORG}`
const raw = { baseUrl: BASE, apiKey: 'ppapi_key', organizationId: ORG, rules: '- название: «Откуда — что — месяц год»' }
const cfg = configOf(papra, raw)

type Tag = { id: string; name: string; documentsCount: number }
type Doc = { id: string; name: string; originalName: string; mimeType: string; originalSize: number; content: string; documentDate: string | null; notes: string | null; createdAt: string; isDeleted: boolean; tags: Tag[] }

const BANK: Tag = { id: 'tag_bank', name: 'Банк', documentsCount: 10 }
const SECRET: Tag = { id: 'tag_private', name: 'private', documentsCount: 1 }

let tags: Tag[]
let docs: Doc[]
let writes: string[]
let failOn: RegExp | null

beforeEach(() => {
  tags = [BANK, SECRET]
  docs = [
    { id: 'doc_scan', name: 'scan_0912', originalName: 'scan_0912.pdf', mimeType: 'application/pdf', originalSize: 8, content: 'Выписка по счёту за август 2026. '.repeat(40), documentDate: null, notes: null, createdAt: '2026-09-20T10:00:00.000Z', isDeleted: false, tags: [] },
    { id: 'doc_pass', name: 'Паспорт', originalName: 'p.jpg', mimeType: 'image/jpeg', originalSize: 4, content: 'секрет', documentDate: null, notes: null, createdAt: '2026-09-21T10:00:00.000Z', isDeleted: false, tags: [SECRET] },
    { id: 'doc_july', name: 'Сбербанк — выписка — июль 2026', originalName: 'x.pdf', mimeType: 'application/pdf', originalSize: 8, content: 'старое', documentDate: '2026-07-31T12:00:00.000Z', notes: 'важно', createdAt: '2026-08-01T10:00:00.000Z', isDeleted: false, tags: [BANK] },
    { id: 'doc_photo', name: 'Чек', originalName: 'c.png', mimeType: 'image/png', originalSize: 4, content: '', documentDate: '2026-08-01T00:00:00.000Z', notes: null, createdAt: '2026-08-02T10:00:00.000Z', isDeleted: false, tags: [BANK] },
  ]
  writes = []
  failOn = null
})

/** Understands only what the connector sends. The real grammar is Papra's; here the terms it is built from. */
function matches(d: Doc, q: string): boolean {
  if (q.includes(`NOT tag:${SECRET.id}`) && d.tags.some((t) => t.id === SECRET.id)) return false
  if (q.includes('(-has:tags OR -has:date)') && d.tags.length && d.documentDate) return false
  if (/(^| )-has:tags/.test(q) && !q.includes('(-has:tags OR') && d.tags.length) return false
  if (/(^|[ (])has:tags/.test(q) && !d.tags.length) return false
  for (const m of q.matchAll(/(?<!NOT )\btag:(tag_\w+)/g)) if (!d.tags.some((t) => t.id === m[1])) return false
  return true
}

function server() {
  return mockFetch(async (c: Call) => {
    expect(c.headers.get('authorization')).toBe('Bearer ppapi_key')
    const p = c.url.pathname
    const q = c.url.searchParams
    if (failOn?.test(`${c.method} ${p}`)) return new Response('{"error":{"message":"boom"}}', { status: 500 })
    if (p === '/api/organizations') return Response.json({ organizations: [{ id: ORG, name: 'Дом' }] })
    if (p === `${API}/tags` && c.method === 'POST') {
      const body = JSON.parse(String(c.body)) as { name: string; color: string }
      expect(body.color).toMatch(/^#[0-9A-F]{6}$/)
      const tag = { id: `tag_new${tags.length}`, name: body.name, documentsCount: 0 }
      tags.push(tag)
      writes.push(`create ${body.name}`)
      return Response.json({ tag })
    }
    if (p === `${API}/tags`) return Response.json({ tags })
    if (p === `${API}/documents/statistics`) return Response.json({ organizationStats: { documentsCount: docs.length } })
    if (p === `${API}/documents`) {
      const list = docs.filter((d) => matches(d, q.get('searchQuery') ?? ''))
      const size = Number(q.get('pageSize') ?? 100)
      const from = Number(q.get('pageIndex') ?? 0) * size
      // Like the real list: no content.
      const page = list.slice(from, from + size).map((d) => ({ ...d, content: undefined }))
      return Response.json({ documents: page, documentsCount: list.length })
    }
    const m = new RegExp(`^${API}/documents/(doc_\\w+)(/file|/tags(?:/(tag_\\w+))?)?$`).exec(p)
    if (m) {
      const doc = docs.find((d) => d.id === m[1])
      if (!doc) return new Response('{}', { status: 404 })
      if (m[2] === '/file') return new Response('%PDF-1.7', { headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''scan.pdf" } })
      if (m[2]?.startsWith('/tags') && c.method === 'POST') {
        const { tagId } = JSON.parse(String(c.body)) as { tagId: string }
        writes.push(`add ${doc.id} ${tagId}`)
        if (doc.tags.some((t) => t.id === tagId)) return Response.json({ error: { code: 'documents.already_has_tag' } }, { status: 409 })
        doc.tags.push(tags.find((t) => t.id === tagId)!)
        return new Response(null, { status: 204 })
      }
      if (m[2]?.startsWith('/tags') && c.method === 'DELETE') {
        writes.push(`remove ${doc.id} ${m[3]}`)
        doc.tags = doc.tags.filter((t) => t.id !== m[3])
        return new Response(null, { status: 204 })
      }
      if (c.method === 'PATCH') {
        const body = JSON.parse(String(c.body)) as Partial<Doc>
        writes.push(`patch ${doc.id} ${JSON.stringify(body)}`)
        Object.assign(doc, body)
        // Like the real PATCH: no tags in the reply.
        return Response.json({ document: { ...doc, tags: undefined } })
      }
      return Response.json({ document: doc })
    }
    return new Response('nope', { status: 404 })
  })
}

describe('Papra connector', () => {
  it('test() reports documents and tags; finds the only organization by itself', async () => {
    server()
    expect(await papra.test(cfg)).toMatchObject({ ok: true, summary: '4 документа', details: ['2 тега', expect.any(String)] })
    const auto = configOf(papra, { baseUrl: BASE, apiKey: 'ppapi_key' })
    expect(await papra.test(auto)).toMatchObject({ ok: true, details: ['Организация «Дом»', '2 тега', expect.any(String)] })
  })

  it('test() refuses a Papra older than 26.5, where the list route ignores the search', async () => {
    mockFetch(async (c) => {
      if (c.url.pathname === `${API}/documents/statistics`) return Response.json({ organizationStats: { documentsCount: 1 } })
      if (c.url.pathname === `${API}/tags`) return Response.json({ tags: [] })
      return Response.json({ documents: [{ id: 'doc_old', name: 'x', mimeType: 'a/b', createdAt: '2026-01-01', tags: [] }], documentsCount: 1 })
    })
    expect(await papra.test(cfg)).toMatchObject({ ok: false, summary: expect.stringContaining('26.5') })
  })

  it('asks for the organization when the key sees several, and rejects a malformed id', async () => {
    mockFetch(async () => Response.json({ organizations: [{ id: 'org_a', name: 'А' }, { id: 'org_b', name: 'Б' }] }))
    const auto = configOf(papra, { baseUrl: BASE, apiKey: 'k' })
    expect(await papra.test(auto)).toMatchObject({ ok: false, summary: expect.stringContaining('А (org_a), Б (org_b)') })
    expect(papra.parseConfig({ baseUrl: BASE, apiKey: 'k', organizationId: '../x' }).ok).toBe(false)
    expect(papra.parseConfig({ baseUrl: BASE })).toMatchObject({ ok: false, errors: { apiKey: expect.any(String) } })
  })

  it('reports a wrong key without leaking it', async () => {
    mockFetch(async () => new Response('{}', { status: 401 }))
    const res = await papra.test(cfg)
    expect(res).toMatchObject({ ok: false, summary: expect.stringContaining('неверный API-ключ') })
    expect(res.summary).not.toContain('ppapi_key')
  })

  it('search builds one query: filters by id, inclusive dates, exclusion last', async () => {
    const calls = server()
    const text = await runTool(papra, 'papra_search', cfg, { query: 'выписка OR счёт', tags: ['банк'], added_before: '2026-01-31', date_after: '2026-07-01', page: 2, limit: 5 })
    const q = calls.find((c) => c.url.pathname === `${API}/documents`)!.url.searchParams
    expect(q.get('searchQuery')).toBe('(выписка OR счёт) AND tag:tag_bank AND created:<2026-02-01 AND date:>=2026-07-01 AND NOT tag:tag_private')
    expect(q.get('pageIndex')).toBe('1')
    expect(q.get('pageSize')).toBe('5')
    expect(text).toBe('Ничего не найдено.')
    await expect(runTool(papra, 'papra_search', cfg, { tags: ['нет-такого'] })).rejects.toThrow('Тега «нет-такого» нет')
    await expect(runTool(papra, 'papra_search', cfg, { date_after: '31.01.2026' })).rejects.toThrow('ГГГГ-ММ-ДД')
    await expect(runTool(papra, 'papra_search', cfg, { date_after: '2026-02-31' })).rejects.toThrow('ГГГГ-ММ-ДД')
  })

  it('search hides excluded documents even when the query lets them through', async () => {
    server()
    const text = await runTool(papra, 'papra_search', cfg)
    expect(text).toContain('• doc_july · «Сбербанк — выписка — июль 2026» · 2026-07-31 · [Банк]')
    expect(text).not.toContain('Паспорт')

    // A server that ignores the filter (or a query that escapes the parentheses).
    mockFetch(async (c) => (c.url.pathname.endsWith('/tags') ? Response.json({ tags }) : Response.json({ documents: docs, documentsCount: docs.length })))
    expect(await runTool(papra, 'papra_search', cfg, { query: 'a) OR (b' })).not.toContain('Паспорт')
  })

  it('review gives rules, text and how recent documents were labeled', async () => {
    const calls = server()
    const text = await runTool(papra, 'papra_review', cfg)
    expect(calls.find((c) => c.url.pathname === `${API}/documents`)!.url.searchParams.get('searchQuery')).toBe('(-has:tags OR -has:date) AND NOT tag:tag_private')
    expect(text).toContain('Правила разметки (от пользователя):\n- название')
    expect(text).toContain('Документов для разметки: 1, в этой пачке 1.')
    expect(text).toContain('doc_scan · добавлен 2026-09-20 · файл scan_0912.pdf · application/pdf')
    expect(text).toContain('Текст: Выписка по счёту')
    expect(text).toContain('Как размечены недавние документы:\n  «Сбербанк — выписка — июль 2026» · 2026-07-31 · [Банк]')
    expect(text).not.toContain('Паспорт')
  })

  it('get pages long text, links to Papra and refuses hidden or trashed documents', async () => {
    server()
    const withWeb = configOf(papra, { ...raw, webUrl: 'https://papra.example.com/' })
    const first = await runTool(papra, 'papra_get', withWeb, { id: 'doc_scan', max_chars: 500 })
    expect(first).toContain('Текст (0–500 из')
    expect(first).toContain('papra_get(id: "doc_scan", offset: 500)')
    expect(first).toContain(`https://papra.example.com/organizations/${ORG}/documents/doc_scan`)
    await expect(runTool(papra, 'papra_get', cfg, { id: 'doc_pass' })).rejects.toThrow('недоступен ассистенту (тег «private»)')
    docs[0]!.isDeleted = true
    await expect(runTool(papra, 'papra_get', cfg, { id: 'doc_scan' })).rejects.toThrow('в корзине')
  })

  it('preview returns images only, within the size limit', async () => {
    server()
    expect(await runToolRaw(papra, 'papra_preview', cfg, { id: 'doc_photo' })).toMatchObject({ images: [{ mimeType: 'image/png' }] })
    await expect(runTool(papra, 'papra_preview', cfg, { id: 'doc_scan' })).rejects.toThrow('только картинку')
    await expect(runTool(papra, 'papra_preview', cfg, { id: 'doc_pass' })).rejects.toThrow('недоступен')
    docs[3]!.originalSize = 3 * 1024 * 1024
    await expect(runTool(papra, 'papra_preview', cfg, { id: 'doc_photo' })).rejects.toThrow('больше 2 МБ')
  })

  it('tags lists counts and marks the hidden one', async () => {
    server()
    const text = await runTool(papra, 'papra_tags', cfg)
    expect(text).toContain('Теги: Банк (10), private (1) — скрыт от ассистента')
    expect(text).toContain('Правила разметки')
  })

  it('update: dry run writes nothing, a real one creates tags and can be undone exactly', async () => {
    server()
    const change = { id: 'doc_scan', name: 'Сбербанк — выписка — август 2026', date: '2026-08-31', notes: 'проверить', add_tags: ['банк', 'выписки'] }
    const plan = await runTool(papra, 'papra_update', cfg, { dry_run: true, changes: [change] })
    expect(plan).toContain('ничего не изменено')
    expect(plan).toContain('Будут созданы теги: «выписки»')
    expect(plan).toContain('теги +выписки +Банк')
    expect(writes).toEqual([])

    const done = await runTool(papra, 'papra_update', cfg, { changes: [change, { id: 'doc_pass', name: 'взлом' }] })
    expect(done).toContain('Обновлено 1 из 2:')
    expect(done).toContain('doc_scan: название «scan_0912» → «Сбербанк — выписка — август 2026»; дата — → 2026-08-31; заметки: проверить; теги +Банк +выписки')
    expect(done).toContain('doc_pass: не изменён — Документ doc_pass недоступен')
    expect(done).toContain('Созданы теги: «выписки»')
    expect(writes).toContain('patch doc_scan {"name":"Сбербанк — выписка — август 2026","documentDate":"2026-08-31","notes":"проверить"}')
    expect(docs[0]!.tags.map((t) => t.name)).toEqual(['Банк', 'выписки'])

    const batch = /papra_undo\(batch: "(pr_\w+)"\)/.exec(done)![1]!
    expect(await runTool(papra, 'papra_undo', cfg, { batch })).toContain(`Откат пачки ${batch}:`)
    expect(docs[0]).toMatchObject({ name: 'scan_0912', documentDate: null, notes: '', tags: [] })
    expect(await runTool(papra, 'papra_undo', cfg, { batch })).toContain('уже откачена')
  })

  it('undo restores the original date value, not just its day', async () => {
    server()
    const done = await runTool(papra, 'papra_update', cfg, { changes: [{ id: 'doc_july', date: '2026-06-30' }] })
    const batch = /batch: "(pr_\w+)"/.exec(done)![1]!
    await runTool(papra, 'papra_undo', cfg, { batch })
    expect(docs[2]!.documentDate).toBe('2026-07-31T12:00:00.000Z')
  })

  it('update: no changes means no writes and no undo offer; a tag already there is fine', async () => {
    server()
    const same = await runTool(papra, 'papra_update', cfg, { changes: [{ id: 'doc_july', add_tags: ['банк'], date: '2026-07-31' }] })
    expect(same).toContain('doc_july: без изменений')
    expect(same).not.toContain('papra_undo')
    expect(writes).toEqual([])
  })

  it('update: a partial failure is reported and what went through can be rolled back', async () => {
    server()
    failOn = /^POST .*\/documents\/doc_scan\/tags$/
    const done = await runTool(papra, 'papra_update', cfg, { changes: [{ id: 'doc_scan', name: 'Новое', add_tags: ['банк'] }] })
    expect(done).toContain('Обновлено 0 из 1:')
    expect(done).toContain('doc_scan: изменён частично — Papra')
    expect(docs[0]!.name).toBe('Новое')
    failOn = null
    await runTool(papra, 'papra_undo', cfg, { batch: /batch: "(pr_\w+)"/.exec(done)![1]! })
    expect(docs[0]!.name).toBe('scan_0912')
  })

  it('undo refuses a document that became hidden', async () => {
    server()
    const done = await runTool(papra, 'papra_update', cfg, { changes: [{ id: 'doc_scan', name: 'Новое' }] })
    docs[0]!.tags = [SECRET]
    const out = await runTool(papra, 'papra_undo', cfg)
    expect(out).toContain('doc_scan: не откачен')
    expect(docs[0]!.name).toBe('Новое')
    expect(done).toContain('papra_undo')
  })

  it('never sends a malformed id to the API', () => {
    const get = papra.tools.find((t) => t.name === 'papra_get')!
    expect(get.inputSchema.safeParse({ id: '../../organizations' }).success).toBe(false)
    expect(get.inputSchema.safeParse({ id: 'doc_abc123' }).success).toBe(true)
  })

  it('link: personal by default, shareable only when asked; hidden documents refused', async () => {
    server()
    expect(await runTool(papra, 'papra_link', cfg, { id: 'doc_scan' })).toMatch(/https:\/\/hub\.example\.com\/f\/[\w-]{32}\nЛичная: 24 часа/)
    expect(await runTool(papra, 'papra_link', cfg, { id: 'doc_scan', shareable: true })).toContain('один раз у любого')
    await expect(runTool(papra, 'papra_link', cfg, { id: 'doc_pass' })).rejects.toThrow('недоступен')
  })

  it('instructions mention only the enabled tools; rules stay out of them', () => {
    const c = configOf(papra, raw)
    const all = papra.tools.map((t) => t.name)
    expect(papra.instructions!(c, { tools: [] })).toBeNull()
    const full = papra.instructions!(c, { tools: all })!
    expect(full).toContain('papra_review')
    expect(full).not.toContain('Откуда — что')
    const readOnly = papra.instructions!(c, { tools: ['papra_search'] })!
    expect(readOnly).toContain('менять метаданные нельзя')
    expect(readOnly).not.toContain('papra_link')
  })

  it('keeps old changes for 30 days only', () => {
    expect(purgeOldPapraChanges(-1)).toBeGreaterThan(0)
    expect(purgeOldPapraChanges(-1)).toBe(0)
  })
})

describe('/f/{token} for Papra', () => {
  const ctx = (token: string) => ({ params: Promise.resolve({ token }) })
  const get = (token: string) => route.GET(new Request(`https://hub.example.com/f/${token}`), ctx(token))
  const save = () => saveConfig(papra, { baseUrl: BASE, apiKey: 'ppapi_key', organizationId: ORG, excludeTag: 'private' })

  it('streams once, inline with the real type, sandboxed', async () => {
    server()
    save()
    const { token } = createLink('doc_scan', { shareable: true })
    const res = await get(token)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''scan.pdf")
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
    expect(await res.text()).toBe('%PDF-1.7')
    expect((await get(token)).status).toBe(410)
  })

  it('anything not safe to show stays an octet-stream download', async () => {
    server()
    save()
    docs[0]!.mimeType = 'text/html'
    const res = await get(createLink('doc_scan', { shareable: true }).token)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('a document hidden or trashed after the link was made does not open', async () => {
    server()
    save()
    const hidden = createLink('doc_scan', { shareable: true }).token
    docs[0]!.tags = [SECRET]
    expect((await get(hidden)).status).toBe(404)
    docs[0]!.tags = []
    docs[0]!.isDeleted = true
    expect((await get(createLink('doc_scan', { shareable: true }).token)).status).toBe(404)
  })
})
