import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configOf, mockFetch, runTool, runToolRaw, setupTempDb, type Call } from './helpers'

const cleanup = await setupTempDb()
process.env.BASE_URL = 'https://hub.example.com'
const { paperless } = await import('@/lib/connectors/paperless')
const { createLink } = await import('@/lib/connectors/paperless/logic')
const { saveConfig } = await import('@/lib/connectors/store')
const route = await import('@/app/f/[token]/route')

afterAll(cleanup)
afterEach(() => vi.unstubAllGlobals())

const BASE = 'http://paperless:8000'
const cfg = configOf(paperless, { baseUrl: BASE, apiToken: 'tok123', rules: '- название: «Корреспондент — что — месяц год»' })

type Doc = { id: number; title: string; content: string; created: string; added: string; correspondent: number | null; document_type: number | null; tags: number[]; original_file_name: string }
let tags: { id: number; name: string; document_count: number; is_inbox_tag?: boolean }[]
let correspondents: { id: number; name: string; document_count: number }[]
let types: { id: number; name: string; document_count: number }[]
let docs: Doc[]
let patches: { id: number; body: Record<string, unknown> }[]
let created: { kind: string; name: string }[]

beforeEach(() => {
  tags = [
    { id: 1, name: 'входящие', document_count: 2, is_inbox_tag: true },
    { id: 2, name: 'банк', document_count: 10 },
    { id: 3, name: 'private', document_count: 1 },
  ]
  correspondents = [{ id: 10, name: 'Сбербанк', document_count: 9 }]
  types = [{ id: 20, name: 'Выписка', document_count: 9 }]
  docs = [
    { id: 118, title: 'scan_0912', content: 'ПАО Сбербанк. Выписка по счёту за август 2026. '.repeat(40), created: '2026-09-12T00:00:00+03:00', added: '2026-09-20T10:00:00+03:00', correspondent: null, document_type: null, tags: [1], original_file_name: 'scan_0912.pdf' },
    { id: 119, title: 'Паспорт', content: 'секрет', created: '2020-01-01', added: '2026-09-21T10:00:00+03:00', correspondent: null, document_type: null, tags: [1, 3], original_file_name: 'p.jpg' },
    { id: 50, title: 'Сбербанк — выписка — июль 2026', content: 'старое', created: '2026-07-31', added: '2026-08-01T10:00:00+03:00', correspondent: 10, document_type: 20, tags: [2], original_file_name: 'x.pdf' },
  ]
  patches = []
  created = []
})

const page = <T,>(results: T[]) => Response.json({ count: results.length, next: null, results })

function server() {
  return mockFetch(async (c: Call) => {
    expect(c.headers.get('authorization')).toBe('Token tok123')
    const p = c.url.pathname
    const q = c.url.searchParams
    if (p === '/api/tags/' && c.method === 'POST') {
      const body = JSON.parse(String(c.body)) as { name: string }
      const t = { id: 100 + tags.length, name: body.name, document_count: 0 }
      tags.push(t)
      created.push({ kind: 'tag', name: body.name })
      return Response.json(t, { status: 201 })
    }
    if (p === '/api/correspondents/' && c.method === 'POST') {
      const body = JSON.parse(String(c.body)) as { name: string }
      const x = { id: 200 + correspondents.length, name: body.name, document_count: 0 }
      correspondents.push(x)
      created.push({ kind: 'correspondent', name: body.name })
      return Response.json(x, { status: 201 })
    }
    if (p === '/api/tags/') return page(tags)
    if (p === '/api/correspondents/') return page(correspondents)
    if (p === '/api/document_types/') return page(types)
    const one = /^\/api\/documents\/(\d+)\/(suggestions\/|thumb\/|download\/)?$/.exec(p)
    if (one) {
      const doc = docs.find((d) => d.id === Number(one[1]))
      if (!doc) return new Response('{}', { status: 404 })
      if (one[2] === 'suggestions/') return Response.json({ correspondents: [10], tags: [2], document_types: [20], dates: ['2026-08-31'] })
      if (one[2] === 'thumb/') return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'content-type': 'image/webp' } })
      if (one[2] === 'download/') return new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="scan.pdf"' } })
      if (c.method === 'PATCH') {
        const body = JSON.parse(String(c.body)) as Record<string, unknown>
        patches.push({ id: doc.id, body })
        Object.assign(doc, body)
        return Response.json(doc)
      }
      return Response.json(doc)
    }
    if (p === '/api/documents/') {
      let list = [...docs]
      const none = q.get('tags__id__none')
      if (none) list = list.filter((d) => !d.tags.includes(Number(none)))
      const all = q.get('tags__id__all')
      if (all) list = list.filter((d) => all.split(',').every((t) => d.tags.includes(Number(t))))
      const inTags = q.get('tags__id__in')
      if (inTags) list = list.filter((d) => inTags.split(',').some((t) => d.tags.includes(Number(t))))
      if (q.get('correspondent__isnull')) list = list.filter((d) => d.correspondent === null)
      if (q.get('document_type__isnull')) list = list.filter((d) => d.document_type === null)
      if (q.get('correspondent__id')) list = list.filter((d) => d.correspondent === Number(q.get('correspondent__id')))
      if (q.get('added__date__gt')) list = list.filter((d) => d.added.slice(0, 10) > q.get('added__date__gt')!)
      if (q.get('query')) list = list.filter((d) => d.content.includes(q.get('query')!))
      const truncated = list.map((d) => (q.get('truncate_content') ? { ...d, content: d.content.slice(0, 300) } : d))
      return Response.json({ count: truncated.length, next: null, results: truncated.slice(0, Number(q.get('page_size') ?? 25)) }, { headers: { 'x-version': '2.18.4' } })
    }
    return new Response('nope', { status: 404 })
  })
}

describe('Paperless connector', () => {
  it('test() reports documents, version and tags', async () => {
    server()
    expect(await paperless.test(cfg)).toMatchObject({ ok: true, summary: '3 документа', details: ['Paperless 2.18.4', '3 тега', expect.any(String)] })
  })

  it('search hides the exclusion tag and maps names and dates to filters', async () => {
    const calls = server()
    const text = await runTool(paperless, 'paperless_search', cfg, { added_after: '2026-09-20' })
    expect(text).toContain('#118 · «scan_0912» · 2026-09-12')
    expect(text).not.toContain('Паспорт')
    const q = calls.find((c) => c.url.pathname === '/api/documents/')!.url.searchParams
    expect(q.get('tags__id__none')).toBe('3')
    expect(q.get('added__date__gt')).toBe('2026-09-19')
    await expect(runTool(paperless, 'paperless_search', cfg, { tags: ['нет-такого'] })).rejects.toThrow('Тега «нет-такого» нет')
  })

  it('review gives rules, text, suggestions and how past documents were labeled', async () => {
    server()
    const text = await runTool(paperless, 'paperless_review', cfg)
    expect(text).toContain('Правила разметки (от пользователя):\n- название')
    expect(text).toContain('Документов для разметки: 1, в этой пачке 1.')
    expect(text).toContain('#118 · добавлен 2026-09-20 · файл scan_0912.pdf')
    expect(text).toContain('Подсказки Paperless: корр. Сбербанк · тип Выписка · теги банк · даты 2026-08-31')
    expect(text).toContain('Как размечены прошлые документы:\nСбербанк:\n  «Сбербанк — выписка — июль 2026» · Выписка · [банк]')
    expect(text).not.toContain('Паспорт')
  })

  it('get pages long text and refuses hidden documents', async () => {
    server()
    const first = await runTool(paperless, 'paperless_get', cfg, { id: 118, max_chars: 500 })
    expect(first).toContain('Текст (0–500 из')
    expect(first).toContain('paperless_get(id: 118, offset: 500)')
    await expect(runTool(paperless, 'paperless_get', cfg, { id: 119 })).rejects.toThrow('недоступен ассистенту (тег «private»)')
  })

  it('thumbnail comes back as an image', async () => {
    server()
    const out = await runToolRaw(paperless, 'paperless_thumbnail', cfg, { id: 118 })
    expect(out).toMatchObject({ images: [{ mimeType: 'image/webp', data: Buffer.from([82, 73, 70, 70]).toString('base64') }] })
  })

  it('update labels in a batch, creates missing names, drops the inbox tag and can be undone', async () => {
    server()
    const plan = await runTool(paperless, 'paperless_update', cfg, {
      dry_run: true,
      changes: [{ id: 118, title: 'Сбербанк — выписка — август 2026', created: '2026-08-31', correspondent: 'сбербанк', document_type: 'Выписка', add_tags: ['банк', 'выписки'] }],
    })
    expect(plan).toContain('ничего не изменено')
    expect(plan).toContain('Будут созданы: тег «выписки»')
    expect(patches).toHaveLength(0)
    expect(created).toHaveLength(0)

    const done = await runTool(paperless, 'paperless_update', cfg, {
      changes: [
        { id: 118, title: 'Сбербанк — выписка — август 2026', created: '2026-08-31', correspondent: 'сбербанк', document_type: 'Выписка', add_tags: ['банк', 'выписки'] },
        { id: 119, title: 'взлом' },
      ],
    })
    expect(done).toContain('Обновлено 1 из 2:')
    expect(done).toContain('#118: название «scan_0912» → «Сбербанк — выписка — август 2026»; дата 2026-09-12 → 2026-08-31; корр. — → Сбербанк; тип — → Выписка; теги +банк +выписки −входящие')
    expect(done).toContain('#119: не изменён — Документ #119 недоступен')
    expect(done).toContain('Созданы: тег «выписки»')
    expect(patches[0]!.body).toMatchObject({ correspondent: 10, document_type: 20, created: '2026-08-31' })
    expect(patches[0]!.body.tags).toEqual([2, 103])

    const batch = /paperless_undo\(batch: "(pb_\w+)"\)/.exec(done)![1]!
    const undone = await runTool(paperless, 'paperless_undo', cfg, { batch })
    expect(undone).toContain(`Откат пачки ${batch}:`)
    expect(docs.find((d) => d.id === 118)).toMatchObject({ title: 'scan_0912', correspondent: null, document_type: null, tags: [1] })
    expect(await runTool(paperless, 'paperless_undo', cfg, { batch })).toContain('уже откачена')
  })

  it('link: personal by default, shareable only when asked; hidden documents refused', async () => {
    server()
    const personal = await runTool(paperless, 'paperless_link', cfg, { id: 118 })
    expect(personal).toMatch(/https:\/\/hub\.example\.com\/f\/[\w-]{32}\nЛичная: 24 часа/)
    expect(await runTool(paperless, 'paperless_link', cfg, { id: 118, shareable: true })).toContain('один раз у любого')
    await expect(runTool(paperless, 'paperless_link', cfg, { id: 119 })).rejects.toThrow('недоступен')
  })
})

describe('/f/{token}', () => {
  const ctx = (token: string) => ({ params: Promise.resolve({ token }) })
  const get = (token: string) => route.GET(new Request(`https://hub.example.com/f/${token}`), ctx(token))

  it('streams a shareable link once, inline for PDFs, sandboxed', async () => {
    server()
    saveConfig(paperless, { baseUrl: BASE, apiToken: 'tok123', excludeTag: 'private', removeInbox: true })
    const { token } = createLink(118, { original: false, shareable: true })
    const res = await get(token)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('inline; filename="scan.pdf"')
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
    expect(await res.text()).toBe('%PDF-1.7')
    expect((await get(token)).status).toBe(410)
  })

  it('404 for unknown tokens, 410 for expired links', async () => {
    expect((await get('x'.repeat(32))).status).toBe(404)
    const { token } = createLink(118, { original: false, shareable: true })
    const { getDb } = await import('@/lib/db')
    const { downloadLink } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    getDb().update(downloadLink).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(downloadLink.token, token)).run()
    expect((await get(token)).status).toBe(410)
  })
})
