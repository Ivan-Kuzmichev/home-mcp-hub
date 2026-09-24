import { createHash } from 'node:crypto'
import { count, min } from 'drizzle-orm'
import { CONNECTORS } from './connectors/registry'
import { listConnectorRows, secretFields } from './connectors/store'
import { decryptSecret, isEncrypted } from './crypto'
import { getDb } from './db'
import { jwks } from './db/schema'

/** Short fingerprint to tell keys apart without showing them: «a3f9 7c21». */
export function fingerprint(secret: string | undefined): string | null {
  if (!secret) return null
  const hex = createHash('sha256').update(secret).digest('hex').slice(0, 8)
  return `${hex.slice(0, 4)} ${hex.slice(4)}`
}

/** How many connector secrets are stored and whether the current master key opens all of them. */
export function secretsStatus(): { total: number; unreadable: number } {
  let total = 0
  let unreadable = 0
  for (const row of listConnectorRows()) {
    const c = CONNECTORS.find((x) => x.id === row.id)
    if (!c) continue
    const stored = JSON.parse(row.configEnc) as Record<string, unknown>
    for (const key of secretFields(c)) {
      const v = stored[key]
      if (!isEncrypted(v)) continue
      total++
      try {
        decryptSecret(v)
      } catch {
        unreadable++
      }
    }
  }
  return { total, unreadable }
}

export function jwksStatus(): { keys: number; oldest: Date | null } {
  const row = getDb().select({ keys: count(), oldest: min(jwks.createdAt) }).from(jwks).get()
  return { keys: row?.keys ?? 0, oldest: row?.oldest ?? null }
}
