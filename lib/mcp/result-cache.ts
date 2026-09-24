import { randomInt } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { getDb } from '../db'
import { searchResult } from '../db/schema'

export const RESULT_TTL_MS = 60 * 60 * 1000

/** What the hub remembers about a search result. Links never carry the Jackett API key. */
export type CachedResult = {
  title: string
  tracker: string
  size: number
  magnet?: string
  /** Jackett /dl/ link with jackett_apikey stripped; the key is added back when downloading */
  link?: string
  infoHash?: string
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function newId(): string {
  let s = 'r_'
  for (let i = 0; i < 5; i++) s += ALPHABET[randomInt(ALPHABET.length)]
  return s
}

export function purgeExpiredResults(now = new Date()): void {
  getDb().delete(searchResult).where(lt(searchResult.expiresAt, now)).run()
}

/** Store results and return their ids in the same order. Also purges expired rows. */
export function cacheResults(connectorId: string, results: CachedResult[]): string[] {
  const db = getDb()
  purgeExpiredResults()
  const expiresAt = new Date(Date.now() + RESULT_TTL_MS)
  return db.transaction((tx) =>
    results.map((r) => {
      const id = newId()
      tx.insert(searchResult).values({ id, connectorId, payloadJson: JSON.stringify(r), expiresAt }).onConflictDoNothing().run()
      return id
    }),
  )
}

export function getCachedResult(id: string): CachedResult | null {
  const row = getDb().select().from(searchResult).where(eq(searchResult.id, id)).get()
  if (!row || row.expiresAt.getTime() < Date.now()) return null
  return JSON.parse(row.payloadJson) as CachedResult
}
