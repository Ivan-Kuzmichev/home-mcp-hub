import { randomInt } from 'node:crypto'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { getDb } from '../../db'
import { papraChange } from '../../db/schema'
import { createLink as createDownloadLink } from '../../download-links'
import { truncate } from '../format'
import { ToolError } from '../types'
import type { PaClient, PaDocument, PaTag } from './client'

// Papra requires a color for a new tag; the assistant does not pick one.
const NEW_TAG_COLOR = '#64748B'

// Same rule as Papra's normalizeTagName.
const norm = (s: string) => s.trim().toLowerCase()

// ---------------------------------------------------------------------------
// Tags: names ⇄ ids, case-insensitive, creating what is missing.

export class TagIndex {
  private readonly byId = new Map<string, PaTag>()
  private readonly byName = new Map<string, PaTag>()
  readonly created: string[] = []

  constructor(tags: PaTag[]) {
    for (const t of tags) this.remember(t)
  }

  private remember(t: PaTag): void {
    this.byId.set(t.id, t)
    this.byName.set(norm(t.name), t)
  }

  name(id: string): string {
    return this.byId.get(id)?.name ?? id
  }

  names(ids: string[]): string[] {
    return ids.map((id) => this.name(id))
  }

  find(name: string): PaTag | undefined {
    return this.byName.get(norm(name))
  }

  /** Existing tag by name, or a new one (dry run: a placeholder). */
  async ensure(name: string, client: PaClient, dryRun: boolean): Promise<PaTag> {
    const found = this.find(name)
    if (found) return found
    const clean = name.trim()
    if (!clean) throw new ToolError('Пустое имя тега')
    const tag: PaTag = dryRun ? { id: `new:${clean}`, name: clean } : await client.createTag(clean, NEW_TAG_COLOR)
    this.remember(tag)
    this.created.push(tag.name)
    return tag
  }
}

// ---------------------------------------------------------------------------
// Access: documents with the exclusion tag are invisible to the assistant.

export function isVisible(doc: PaDocument, excludeTag: string | undefined): boolean {
  if (!excludeTag) return true
  const hidden = norm(excludeTag)
  return !doc.tags.some((t) => norm(t.name) === hidden)
}

export function assertVisible(doc: PaDocument, excludeTag: string | undefined): void {
  if (doc.isDeleted) throw new ToolError(`Документ ${doc.id} в корзине`)
  if (!isVisible(doc, excludeTag)) throw new ToolError(`Документ ${doc.id} недоступен ассистенту (тег «${excludeTag}»)`)
}

// ---------------------------------------------------------------------------
// Search: Papra has one query language, so every filter becomes part of searchQuery.

export type DocFilter = {
  query?: string
  tags?: string[]
  addedAfter?: string
  addedBefore?: string
  dateAfter?: string
  dateBefore?: string
}

export function checkedDay(date: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) throw new ToolError(`Дата «${date}» — нужен формат ГГГГ-ММ-ДД`)
  return date
}

function nextDay(date: string): string {
  const d = new Date(`${checkedDay(date)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export type ReviewScope = 'unlabeled' | 'untagged' | 'all'

const SCOPE_QUERY: Record<ReviewScope, string | null> = { unlabeled: '(-has:tags OR -has:date)', untagged: '-has:tags', all: null }

/**
 * Tags go by id, so names need no quoting. The model's own query stays in parentheses and an OR
 * in it cannot cancel the exclusion; results are also filtered after the fact (isVisible).
 * «Before» is inclusive: `<=2026-01-31` would stop at midnight of that day.
 */
export function searchQuery(f: DocFilter, index: TagIndex, excludeTag: string | undefined, scope: ReviewScope = 'all'): string {
  const parts: string[] = []
  if (f.query?.trim()) parts.push(`(${f.query.trim()})`)
  const scoped = SCOPE_QUERY[scope]
  if (scoped) parts.push(scoped)
  for (const name of f.tags ?? []) {
    const tag = index.find(name)
    if (!tag) throw new ToolError(`Тега «${name}» нет — посмотри papra_tags`)
    parts.push(`tag:${tag.id}`)
  }
  if (f.addedAfter) parts.push(`created:>=${checkedDay(f.addedAfter)}`)
  if (f.addedBefore) parts.push(`created:<${nextDay(f.addedBefore)}`)
  if (f.dateAfter) parts.push(`date:>=${checkedDay(f.dateAfter)}`)
  if (f.dateBefore) parts.push(`date:<${nextDay(f.dateBefore)}`)
  const hidden = excludeTag ? index.find(excludeTag) : undefined
  if (hidden) parts.push(`NOT tag:${hidden.id}`)
  return parts.join(' AND ')
}

// ---------------------------------------------------------------------------
// Formatting

export const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—')

const tagNames = (d: PaDocument) => d.tags.map((t) => t.name).join(', ')

export function docLine(d: PaDocument): string {
  const parts = [`${d.id} · «${truncate(d.name, 70)}» · ${day(d.documentDate)}`, d.tags.length ? `[${tagNames(d)}]` : null].filter(Boolean)
  return `• ${parts.join(' · ')}`
}

export function metaLine(d: PaDocument): string {
  return [`название «${d.name}»`, `дата ${day(d.documentDate)}`, `теги [${tagNames(d)}]`, d.notes ? `заметки: ${truncate(d.notes, 300)}` : null].filter(Boolean).join(' · ')
}

export function headLine(d: PaDocument): string {
  return `${d.id} · добавлен ${day(d.createdAt)}${d.originalName ? ` · файл ${d.originalName}` : ''} · ${d.mimeType}`
}

// ---------------------------------------------------------------------------
// Updates with undo

export type Change = {
  id: string
  name?: string
  date?: string | null
  notes?: string
  content?: string
  tags?: string[]
  add_tags?: string[]
  remove_tags?: string[]
}

/** content is absent in a stored snapshot unless that edit changed it: no reason to keep every text twice. */
export type Snapshot = { name: string; documentDate: string | null; notes: string; content?: string; tags: string[] }

/** The date keeps its full value, so an undo restores exactly what was there. */
export const snapshot = (d: PaDocument): Snapshot => ({
  name: d.name,
  documentDate: d.documentDate ?? null,
  notes: d.notes ?? '',
  content: d.content ?? '',
  tags: d.tags.map((t) => t.id).sort(),
})

export function newBatchId(): string {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789'
  let s = 'pr_'
  for (let i = 0; i < 6; i++) s += a[randomInt(a.length)]
  return s
}

/** Resolve a change into the next snapshot; creates missing tags unless dryRun. */
export async function plan(doc: PaDocument, change: Change, index: TagIndex, client: PaClient, opts: { dryRun: boolean }): Promise<Snapshot> {
  const next = snapshot(doc)
  if (change.name !== undefined) {
    const n = change.name.trim()
    if (!n) throw new ToolError(`${doc.id}: пустое название`)
    next.name = n.slice(0, 255)
  }
  if (change.date !== undefined) next.documentDate = change.date === null ? null : checkedDay(change.date)
  if (change.notes !== undefined) next.notes = change.notes
  if (change.content !== undefined) next.content = change.content

  let tags = new Set(next.tags)
  if (change.tags) {
    tags = new Set()
    for (const t of change.tags) tags.add((await index.ensure(t, client, opts.dryRun)).id)
  }
  for (const t of change.add_tags ?? []) tags.add((await index.ensure(t, client, opts.dryRun)).id)
  for (const t of change.remove_tags ?? []) {
    const found = index.find(t)
    if (found) tags.delete(found.id)
  }
  next.tags = [...tags].sort()
  return next
}

export function patchOf(before: Snapshot, after: Snapshot): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (before.name !== after.name) p.name = after.name
  if (day(before.documentDate) !== day(after.documentDate)) p.documentDate = after.documentDate
  if (before.notes !== after.notes) p.notes = after.notes
  if (after.content !== undefined && before.content !== after.content) p.content = after.content
  return p
}

/**
 * Papra edits fields and each tag with separate requests, so a failure can leave a document half
 * changed. onWrite fires on the first change that went through: the caller records the undo then.
 */
export async function applyDiff(client: PaClient, id: string, before: Snapshot, after: Snapshot, onWrite: () => void): Promise<void> {
  const patch = patchOf(before, after)
  if (Object.keys(patch).length) {
    await client.update(id, patch)
    onWrite()
  }
  for (const tagId of after.tags.filter((t) => !before.tags.includes(t))) {
    await client.addTag(id, tagId)
    onWrite()
  }
  for (const tagId of before.tags.filter((t) => !after.tags.includes(t))) {
    await client.removeTag(id, tagId)
    onWrite()
  }
}

export function hasChanges(before: Snapshot, after: Snapshot): boolean {
  return Object.keys(patchOf(before, after)).length > 0 || before.tags.join() !== after.tags.join()
}

export function diffLine(id: string, before: Snapshot, after: Snapshot, index: TagIndex): string {
  const parts: string[] = []
  if (before.name !== after.name) parts.push(`название «${truncate(before.name, 40)}» → «${truncate(after.name, 60)}»`)
  if (day(before.documentDate) !== day(after.documentDate)) parts.push(`дата ${day(before.documentDate)} → ${day(after.documentDate)}`)
  if (before.notes !== after.notes) parts.push(after.notes ? `заметки: ${truncate(after.notes, 60)}` : 'заметки убраны')
  if (after.content !== undefined && before.content !== after.content) parts.push(`текст: ${before.content?.length ?? 0} → ${after.content.length} симв.`)
  const added = after.tags.filter((t) => !before.tags.includes(t))
  const removed = before.tags.filter((t) => !after.tags.includes(t))
  if (added.length || removed.length) {
    parts.push(`теги ${[...index.names(added).map((n) => `+${n}`), ...index.names(removed).map((n) => `−${n}`)].join(' ')}`)
  }
  return `${id}: ${parts.length ? parts.join('; ') : 'без изменений'}`
}

export function recordChange(batchId: string, documentId: string, before: Snapshot, after: Snapshot): void {
  const changed = before.content !== after.content
  const stored = (s: Snapshot) => JSON.stringify(changed ? s : { ...s, content: undefined })
  getDb()
    .insert(papraChange)
    .values({ batchId, documentId, beforeJson: stored(before), afterJson: stored(after), createdAt: new Date() })
    .run()
}

export function batchChanges(batchId: string) {
  return getDb()
    .select()
    .from(papraChange)
    .where(and(eq(papraChange.batchId, batchId), isNull(papraChange.undoneAt)))
    .all()
}

export function markUndone(id: number): void {
  getDb().update(papraChange).set({ undoneAt: new Date() }).where(eq(papraChange.id, id)).run()
}

export function lastBatchId(): string | null {
  const row = getDb().select({ batchId: papraChange.batchId }).from(papraChange).where(isNull(papraChange.undoneAt)).orderBy(papraChange.id).all().at(-1)
  return row?.batchId ?? null
}

export function purgeOldPapraChanges(days = 30): number {
  return getDb().delete(papraChange).where(lt(papraChange.createdAt, new Date(Date.now() - days * 86_400_000))).run().changes
}

// ---------------------------------------------------------------------------
// Download links: storage is shared with Paperless and Files (lib/download-links.ts).

export function createLink(documentId: string, opts: { shareable: boolean }): { token: string; expiresAt: Date } {
  return createDownloadLink({ connectorId: 'papra', documentId }, { shareable: opts.shareable })
}
