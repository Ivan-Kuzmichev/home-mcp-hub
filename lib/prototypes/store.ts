import { randomInt, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { and, desc, eq, isNotNull, lt, sql } from 'drizzle-orm'
import { getDb } from '../db'
import { prototype } from '../db/schema'

export type Prototype = typeof prototype.$inferSelect

/** One tool call; Claude's argument size is the practical limit. */
export const MAX_TOOL_HTML_BYTES = 1024 * 1024
/** Stored file, e.g. a manual upload in the admin panel. */
export const MAX_HTML_BYTES = 5 * 1024 * 1024
export const KEEP_VERSIONS = 3
/** Expired prototypes answer 410 for a week, then the files are removed. */
export const EXPIRED_GRACE_MS = 7 * 24 * 60 * 60 * 1000
export const PIN_PATTERN = /^\d{4,8}$/

export type Expiry = 'never' | '7d' | '30d'
export const EXPIRY_DAYS: Record<Expiry, number | null> = { never: null, '7d': 7, '30d': 30 }

export class PrototypeError extends Error {}

const SLUG_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz' // no 0/o/1/l: readable when dictated

export function prototypesDir(): string {
  return path.join(path.dirname(path.resolve(process.env.DATABASE_PATH ?? '/data/hub.db')), 'prototypes')
}

function fileFor(id: string, version: number): string {
  return path.join(prototypesDir(), id, `v${version}.html`)
}

function newSlug(): string {
  let s = ''
  for (let i = 0; i < 10; i++) s += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)]
  return s
}

export function expiryDate(expiry: Expiry, from = new Date()): Date | null {
  const days = EXPIRY_DAYS[expiry]
  return days === null ? null : new Date(from.getTime() + days * 86_400_000)
}

export function isExpired(p: Pick<Prototype, 'expiresAt'>, now = new Date()): boolean {
  return !!p.expiresAt && p.expiresAt.getTime() <= now.getTime()
}

function checkHtml(html: string, limit: number): number {
  const size = Buffer.byteLength(html, 'utf8')
  if (size === 0) throw new PrototypeError('Пустой HTML')
  if (size > limit) throw new PrototypeError(`HTML ${(size / 1024 / 1024).toFixed(1)} МБ — больше лимита ${limit / 1024 / 1024} МБ`)
  return size
}

async function hashPin(pin: string): Promise<string> {
  if (!PIN_PATTERN.test(pin)) throw new PrototypeError('Пин — от 4 до 8 цифр')
  return argonHash(pin)
}

export function verifyPin(p: Pick<Prototype, 'pinHash'>, pin: string): Promise<boolean> {
  if (!p.pinHash || !PIN_PATTERN.test(pin)) return Promise.resolve(false)
  return argonVerify(p.pinHash, pin).catch(() => false)
}

function writeVersion(id: string, version: number, html: string): void {
  const file = fileFor(id, version)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, html, 'utf8')
  // Keep the last KEEP_VERSIONS versions.
  for (const v of listVersionNumbers(id)) if (v <= version - KEEP_VERSIONS) fs.rmSync(fileFor(id, v), { force: true })
}

function listVersionNumbers(id: string): number[] {
  const dir = path.join(prototypesDir(), id)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((f) => /^v(\d+)\.html$/.exec(f)?.[1])
    .filter((v): v is string => !!v)
    .map(Number)
    .sort((a, b) => b - a)
}

export function listVersions(id: string): { version: number; savedAt: Date; size: number }[] {
  return listVersionNumbers(id).map((version) => {
    const stat = fs.statSync(fileFor(id, version))
    return { version, savedAt: stat.mtime, size: stat.size }
  })
}

export function readHtml(p: Pick<Prototype, 'id' | 'version'>, version = p.version): string | null {
  try {
    return fs.readFileSync(fileFor(p.id, version), 'utf8')
  } catch {
    return null
  }
}

export function getBySlug(slug: string): Prototype | undefined {
  return getDb().select().from(prototype).where(eq(prototype.slug, slug)).get()
}

export function getById(id: string): Prototype | undefined {
  return getDb().select().from(prototype).where(eq(prototype.id, id)).get()
}

export function listPrototypes(): Prototype[] {
  return getDb().select().from(prototype).orderBy(desc(prototype.updatedAt)).all()
}

export async function publish(input: { html: string; title: string; pin?: string; expiry?: Expiry; maxBytes?: number }): Promise<Prototype> {
  const size = checkHtml(input.html, input.maxBytes ?? MAX_HTML_BYTES)
  const title = input.title.trim().slice(0, 200)
  if (!title) throw new PrototypeError('Нужно название')
  const pinHash = input.pin ? await hashPin(input.pin) : null
  const now = new Date()
  const id = randomUUID()
  let slug = newSlug()
  while (getBySlug(slug)) slug = newSlug()
  writeVersion(id, 1, input.html)
  const row = { id, slug, title, pinHash, pinVersion: 0, expiresAt: expiryDate(input.expiry ?? 'never', now), sizeBytes: size, version: 1, views: 0, lastViewedAt: null, createdAt: now, updatedAt: now }
  getDb().insert(prototype).values(row).run()
  return row
}

export async function update(
  p: Prototype,
  change: { html?: string; title?: string; pin?: string | null; expiry?: Expiry; maxBytes?: number },
): Promise<Prototype> {
  const now = new Date()
  const set: Partial<Prototype> = { updatedAt: now }
  if (change.html !== undefined) {
    set.sizeBytes = checkHtml(change.html, change.maxBytes ?? MAX_HTML_BYTES)
    set.version = p.version + 1
    writeVersion(p.id, set.version, change.html)
  }
  if (change.title !== undefined) {
    const title = change.title.trim().slice(0, 200)
    if (!title) throw new PrototypeError('Нужно название')
    set.title = title
  }
  if (change.pin !== undefined) {
    set.pinHash = change.pin === null ? null : await hashPin(change.pin)
    // Old access cookies stop working after any pin change.
    set.pinVersion = p.pinVersion + 1
  }
  if (change.expiry !== undefined) set.expiresAt = expiryDate(change.expiry, now)
  getDb().update(prototype).set(set).where(eq(prototype.id, p.id)).run()
  return { ...p, ...set }
}

/** Rollback = the old file becomes a new version, so history stays linear. */
export async function rollback(p: Prototype, version: number): Promise<Prototype> {
  const html = readHtml(p, version)
  if (html === null) throw new PrototypeError(`Версии v${version} нет`)
  return update(p, { html })
}

export function remove(p: Pick<Prototype, 'id'>): void {
  getDb().delete(prototype).where(eq(prototype.id, p.id)).run()
  fs.rmSync(path.join(prototypesDir(), p.id), { recursive: true, force: true })
}

export function recordView(p: Pick<Prototype, 'id'>): void {
  getDb()
    .update(prototype)
    .set({ views: sql`${prototype.views} + 1`, lastViewedAt: new Date() })
    .where(eq(prototype.id, p.id))
    .run()
}

/** Delete prototypes expired more than EXPIRED_GRACE_MS ago. Returns how many. */
export function purgeExpired(now = new Date()): number {
  const cutoff = new Date(now.getTime() - EXPIRED_GRACE_MS)
  const old = getDb()
    .select({ id: prototype.id })
    .from(prototype)
    .where(and(isNotNull(prototype.expiresAt), lt(prototype.expiresAt, cutoff)))
    .all()
  for (const p of old) remove(p)
  return old.length
}

export function totalSize(): number {
  return listPrototypes().reduce((sum, p) => sum + p.sizeBytes, 0)
}

export function publicUrl(slug: string): string {
  const base = (process.env.BASE_URL ?? '').replace(/\/+$/, '')
  return `${base}/p/${slug}`
}

/** Accept a slug, «/p/slug» or a full URL — whatever Claude has at hand. */
export function slugFrom(ref: string): string {
  const m = /\/p\/([a-z0-9]+)/i.exec(ref)
  return (m?.[1] ?? ref).trim().toLowerCase()
}
