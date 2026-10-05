import { randomBytes } from 'node:crypto'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { getDb } from './db'
import { downloadLink } from './db/schema'

// ---------------------------------------------------------------------------
// Download links (/f/{token}, outside the secret prefix like /p/): Paperless documents
// and files from the Files connector.

export const PERSONAL_LINK_TTL_MS = 24 * 60 * 60 * 1000
export const SHAREABLE_LINK_TTL_MS = 15 * 60 * 1000

export type LinkTarget = { connectorId: 'paperless'; documentId: number; original: boolean } | { connectorId: 'files'; path: string }

export function createLink(target: LinkTarget, opts: { shareable: boolean }): { token: string; expiresAt: Date } {
  const token = randomBytes(24).toString('base64url')
  const now = Date.now()
  const expiresAt = new Date(now + (opts.shareable ? SHAREABLE_LINK_TTL_MS : PERSONAL_LINK_TTL_MS))
  const values =
    target.connectorId === 'paperless'
      ? { connectorId: target.connectorId, documentId: target.documentId, original: target.original }
      : // document_id is NOT NULL from the Paperless-only days; files keep 0 there.
        { connectorId: target.connectorId, documentId: 0, path: target.path }
  getDb()
    .insert(downloadLink)
    .values({ token, ...values, shareable: opts.shareable, expiresAt, createdAt: new Date(now) })
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

export const LINK_KIND_TEXT = {
  personal: 'Личная: 24 часа, открывается только в браузере, где выполнен вход в админку хаба.',
  shareable: 'Пересылаемая: откроется один раз у любого, у кого ссылка, в течение 15 минут.',
}
