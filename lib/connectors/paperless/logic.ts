import { randomBytes, randomInt } from 'node:crypto'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { getDb } from '../../db'
import { downloadLink, paperlessChange } from '../../db/schema'
import { truncate } from '../format'
import { ToolError } from '../types'
import type { PlClient, PlDocument, PlKind, PlNamed, PlSuggestions, Taxonomy } from './client'

// ---------------------------------------------------------------------------
// Taxonomy: names ⇄ ids, case-insensitive, creating what is missing.

const norm = (s: string) => s.trim().toLocaleLowerCase('ru')

export class TaxonomyIndex {
  private readonly byId: Record<PlKind, Map<number, PlNamed>>
  private readonly byName: Record<PlKind, Map<string, PlNamed>>
  readonly created: { kind: PlKind; name: string }[] = []

  constructor(private readonly tax: Taxonomy) {
    const lists: Record<PlKind, PlNamed[]> = { tags: tax.tags, correspondents: tax.correspondents, document_types: tax.documentTypes }
    this.byId = { tags: new Map(), correspondents: new Map(), document_types: new Map() }
    this.byName = { tags: new Map(), correspondents: new Map(), document_types: new Map() }
    for (const kind of Object.keys(lists) as PlKind[]) {
      for (const item of lists[kind]) {
        this.byId[kind].set(item.id, item)
        this.byName[kind].set(norm(item.name), item)
      }
    }
  }

  name(kind: PlKind, id: number | null | undefined): string | null {
    return id == null ? null : (this.byId[kind].get(id)?.name ?? `#${id}`)
  }

  names(kind: PlKind, ids: number[]): string[] {
    return ids.map((id) => this.name(kind, id)!).filter(Boolean)
  }

  find(kind: PlKind, name: string): PlNamed | undefined {
    return this.byName[kind].get(norm(name))
  }

  /** Existing entry by name, or a new one (dry run: a placeholder with id -1). */
  async ensure(kind: PlKind, name: string, client: PlClient, dryRun: boolean): Promise<PlNamed> {
    const found = this.find(kind, name)
    if (found) return found
    const clean = name.trim()
    if (!clean) throw new ToolError('Пустое имя тега, корреспондента или типа')
    const item: PlNamed = dryRun ? { id: -1 - this.created.length, name: clean } : await client.create(kind, clean)
    this.byId[kind].set(item.id, item)
    this.byName[kind].set(norm(item.name), item)
    this.created.push({ kind, name: item.name })
    return item
  }

  inboxTagIds(): number[] {
    return this.tax.tags.filter((t) => t.is_inbox_tag).map((t) => t.id)
  }
}

export const KIND_LABELS: Record<PlKind, string> = { tags: 'тег', correspondents: 'корреспондент', document_types: 'тип' }

// ---------------------------------------------------------------------------
// Access: documents with the exclusion tag are invisible to the assistant.

export function excludedTagId(index: TaxonomyIndex, excludeTag: string | undefined): number | null {
  if (!excludeTag) return null
  return index.find('tags', excludeTag)?.id ?? null
}

export function assertVisible(doc: PlDocument, excludedId: number | null, excludeTag: string | undefined): void {
  if (excludedId !== null && doc.tags.includes(excludedId)) {
    throw new ToolError(`Документ #${doc.id} недоступен ассистенту (тег «${excludeTag}»)`)
  }
}

// ---------------------------------------------------------------------------
// Filters

export type DocFilter = {
  query?: string
  tags?: string[]
  correspondent?: string
  documentType?: string
  addedAfter?: string
  addedBefore?: string
  createdAfter?: string
  createdBefore?: string
}

function dayShift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) throw new ToolError(`Дата «${date}» — нужен формат ГГГГ-ММ-ДД`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Query params understood by both paperless-ng and paperless-ngx. Inclusive ranges are
 * expressed with date__gt/date__lt (older versions have no __gte/__lte).
 */
export function filterParams(f: DocFilter, index: TaxonomyIndex, excludedId: number | null): Record<string, string | number | undefined> {
  const p: Record<string, string | number | undefined> = { ordering: '-added', truncate_content: 'true' }
  if (f.query) p.query = f.query
  if (f.tags?.length) {
    const ids = f.tags.map((t) => {
      const tag = index.find('tags', t)
      if (!tag) throw new ToolError(`Тега «${t}» нет — посмотри paperless_taxonomy`)
      return tag.id
    })
    p.tags__id__all = ids.join(',')
  }
  if (f.correspondent) {
    const c = index.find('correspondents', f.correspondent)
    if (!c) throw new ToolError(`Корреспондента «${f.correspondent}» нет — посмотри paperless_taxonomy`)
    p.correspondent__id = c.id
  }
  if (f.documentType) {
    const t = index.find('document_types', f.documentType)
    if (!t) throw new ToolError(`Типа «${f.documentType}» нет — посмотри paperless_taxonomy`)
    p.document_type__id = t.id
  }
  if (f.addedAfter) p.added__date__gt = dayShift(f.addedAfter, -1)
  if (f.addedBefore) p.added__date__lt = dayShift(f.addedBefore, 1)
  if (f.createdAfter) p.created__date__gt = dayShift(f.createdAfter, -1)
  if (f.createdBefore) p.created__date__lt = dayShift(f.createdBefore, 1)
  if (excludedId !== null) p.tags__id__none = excludedId
  return p
}

export type ReviewScope = 'unlabeled' | 'inbox' | 'all'

/**
 * Documents to label. «unlabeled» = inbox tag OR no correspondent OR no document type:
 * the API cannot OR filters, so up to three queries are merged by id.
 */
export async function reviewDocuments(
  client: PlClient,
  base: Record<string, string | number | undefined>,
  scope: ReviewScope,
  index: TaxonomyIndex,
  limit: number,
): Promise<{ total: number; docs: PlDocument[] }> {
  const variants: Record<string, string | number | undefined>[] = []
  const inbox = index.inboxTagIds()
  if (scope === 'all') variants.push({})
  if (scope === 'inbox' || scope === 'unlabeled') {
    if (inbox.length) variants.push({ tags__id__in: inbox.join(',') })
    else if (scope === 'inbox') throw new ToolError('В Paperless нет тега «входящие» (inbox tag)')
  }
  if (scope === 'unlabeled') variants.push({ correspondent__isnull: 'true' }, { document_type__isnull: 'true' })

  const merged = new Map<number, PlDocument>()
  let total = 0
  for (const v of variants) {
    const page = await client.documents({ ...base, ...v, page_size: 100 })
    total = Math.max(total, page.count)
    for (const d of page.results) merged.set(d.id, d)
  }
  const docs = [...merged.values()].sort((a, b) => b.added.localeCompare(a.added))
  return { total: Math.max(total, docs.length), docs: docs.slice(0, limit) }
}

// ---------------------------------------------------------------------------
// Formatting

export const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—')

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

export function docLine(d: PlDocument, index: TaxonomyIndex): string {
  const parts = [
    `#${d.id} · «${truncate(d.title, 70)}» · ${day(d.created)}`,
    index.name('correspondents', d.correspondent),
    index.name('document_types', d.document_type),
    d.tags.length ? `[${index.names('tags', d.tags).join(', ')}]` : null,
  ].filter(Boolean)
  const hit = d.__search_hit__?.highlights ? `\n  …${truncate(stripHtml(d.__search_hit__.highlights), 160)}…` : ''
  return `• ${parts.join(' · ')}${hit}`
}

export function metaLine(d: PlDocument, index: TaxonomyIndex): string {
  return [
    `название «${d.title}»`,
    `дата ${day(d.created)}`,
    `корр. ${index.name('correspondents', d.correspondent) ?? '—'}`,
    `тип ${index.name('document_types', d.document_type) ?? '—'}`,
    `теги [${index.names('tags', d.tags).join(', ')}]`,
  ].join(' · ')
}

export function suggestionLine(s: PlSuggestions | null, index: TaxonomyIndex): string | null {
  if (!s) return null
  const parts = [
    s.correspondents.length ? `корр. ${index.names('correspondents', s.correspondents.slice(0, 2)).join(' / ')}` : null,
    s.document_types.length ? `тип ${index.names('document_types', s.document_types.slice(0, 2)).join(' / ')}` : null,
    s.tags.length ? `теги ${index.names('tags', s.tags.slice(0, 6)).join(', ')}` : null,
    s.dates.length ? `даты ${s.dates.slice(0, 3).join(', ')}` : null,
  ].filter(Boolean)
  return parts.length ? `Подсказки Paperless: ${parts.join(' · ')}` : null
}

// ---------------------------------------------------------------------------
// Updates with undo

export type Change = {
  id: number
  title?: string
  created?: string
  correspondent?: string | null
  document_type?: string | null
  tags?: string[]
  add_tags?: string[]
  remove_tags?: string[]
  keep_inbox?: boolean
}

export type Snapshot = { title: string; created: string; correspondent: number | null; document_type: number | null; tags: number[] }

export const snapshot = (d: PlDocument): Snapshot => ({
  title: d.title,
  created: day(d.created),
  correspondent: d.correspondent,
  document_type: d.document_type,
  tags: [...d.tags].sort((a, b) => a - b),
})

export function newBatchId(): string {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789'
  let s = 'pb_'
  for (let i = 0; i < 6; i++) s += a[randomInt(a.length)]
  return s
}

/** Resolve a change into the next snapshot; creates missing names unless dryRun. */
export async function plan(
  doc: PlDocument,
  change: Change,
  index: TaxonomyIndex,
  client: PlClient,
  opts: { dryRun: boolean; removeInbox: boolean },
): Promise<Snapshot> {
  const next = snapshot(doc)
  if (change.title !== undefined) {
    const t = change.title.trim()
    if (!t) throw new ToolError(`#${doc.id}: пустое название`)
    next.title = t.slice(0, 128)
  }
  if (change.created !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(change.created)) throw new ToolError(`#${doc.id}: дата «${change.created}» — нужен ГГГГ-ММ-ДД`)
    next.created = change.created
  }
  if (change.correspondent !== undefined) next.correspondent = change.correspondent === null ? null : (await index.ensure('correspondents', change.correspondent, client, opts.dryRun)).id
  if (change.document_type !== undefined) next.document_type = change.document_type === null ? null : (await index.ensure('document_types', change.document_type, client, opts.dryRun)).id

  let tags = new Set(next.tags)
  if (change.tags) tags = new Set(await Promise.all(change.tags.map(async (t) => (await index.ensure('tags', t, client, opts.dryRun)).id)))
  for (const t of change.add_tags ?? []) tags.add((await index.ensure('tags', t, client, opts.dryRun)).id)
  for (const t of change.remove_tags ?? []) {
    const found = index.find('tags', t)
    if (found) tags.delete(found.id)
  }
  // Labeled documents leave the inbox unless asked otherwise.
  if (opts.removeInbox && !change.keep_inbox) for (const id of index.inboxTagIds()) tags.delete(id)
  next.tags = [...tags].sort((a, b) => a - b)
  return next
}

export function patchOf(before: Snapshot, after: Snapshot): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (before.title !== after.title) p.title = after.title
  if (before.created !== after.created) p.created = after.created
  if (before.correspondent !== after.correspondent) p.correspondent = after.correspondent
  if (before.document_type !== after.document_type) p.document_type = after.document_type
  if (before.tags.join() !== after.tags.join()) p.tags = after.tags
  return p
}

export function diffLine(id: number, before: Snapshot, after: Snapshot, index: TaxonomyIndex): string {
  const parts: string[] = []
  if (before.title !== after.title) parts.push(`название «${truncate(before.title, 40)}» → «${truncate(after.title, 60)}»`)
  if (before.created !== after.created) parts.push(`дата ${before.created} → ${after.created}`)
  if (before.correspondent !== after.correspondent) {
    parts.push(`корр. ${index.name('correspondents', before.correspondent) ?? '—'} → ${index.name('correspondents', after.correspondent) ?? '—'}`)
  }
  if (before.document_type !== after.document_type) {
    parts.push(`тип ${index.name('document_types', before.document_type) ?? '—'} → ${index.name('document_types', after.document_type) ?? '—'}`)
  }
  const added = after.tags.filter((t) => !before.tags.includes(t))
  const removed = before.tags.filter((t) => !after.tags.includes(t))
  if (added.length || removed.length) {
    parts.push(`теги ${[...index.names('tags', added).map((n) => `+${n}`), ...index.names('tags', removed).map((n) => `−${n}`)].join(' ')}`)
  }
  return `#${id}: ${parts.length ? parts.join('; ') : 'без изменений'}`
}

export function recordChange(batchId: string, documentId: number, before: Snapshot, after: Snapshot): void {
  getDb()
    .insert(paperlessChange)
    .values({ batchId, documentId, beforeJson: JSON.stringify(before), afterJson: JSON.stringify(after), createdAt: new Date() })
    .run()
}

export function batchChanges(batchId: string) {
  return getDb()
    .select()
    .from(paperlessChange)
    .where(and(eq(paperlessChange.batchId, batchId), isNull(paperlessChange.undoneAt)))
    .all()
}

export function markUndone(id: number): void {
  getDb().update(paperlessChange).set({ undoneAt: new Date() }).where(eq(paperlessChange.id, id)).run()
}

export function lastBatchId(): string | null {
  const row = getDb().select({ batchId: paperlessChange.batchId }).from(paperlessChange).where(isNull(paperlessChange.undoneAt)).orderBy(paperlessChange.id).all().at(-1)
  return row?.batchId ?? null
}

export function purgeOldChanges(days = 30): number {
  return getDb().delete(paperlessChange).where(lt(paperlessChange.createdAt, new Date(Date.now() - days * 86_400_000))).run().changes
}

// ---------------------------------------------------------------------------
// Download links (/f/{token}, outside the secret prefix like /p/)

export const PERSONAL_LINK_TTL_MS = 24 * 60 * 60 * 1000
export const SHAREABLE_LINK_TTL_MS = 15 * 60 * 1000

export function createLink(documentId: number, opts: { original: boolean; shareable: boolean }): { token: string; expiresAt: Date } {
  const token = randomBytes(24).toString('base64url')
  const now = Date.now()
  const expiresAt = new Date(now + (opts.shareable ? SHAREABLE_LINK_TTL_MS : PERSONAL_LINK_TTL_MS))
  getDb()
    .insert(downloadLink)
    .values({ token, connectorId: 'paperless', documentId, original: opts.original, shareable: opts.shareable, expiresAt, createdAt: new Date(now) })
    .run()
  return { token, expiresAt }
}

export function getLink(token: string) {
  return getDb().select().from(downloadLink).where(eq(downloadLink.token, token)).get()
}

/** One-time links: mark used atomically, so two parallel opens cannot both succeed. */
export function claimLink(token: string): boolean {
  return getDb().update(downloadLink).set({ usedAt: new Date() }).where(and(eq(downloadLink.token, token), isNull(downloadLink.usedAt))).run().changes === 1
}

export function purgeExpiredLinks(): number {
  return getDb().delete(downloadLink).where(lt(downloadLink.expiresAt, new Date())).run().changes
}

export function linkUrl(token: string): string {
  return `${(process.env.BASE_URL ?? '').replace(/\/+$/, '')}/f/${token}`
}
