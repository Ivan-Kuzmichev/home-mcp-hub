import { and, count, desc, eq, gt, isNull } from 'drizzle-orm'
import { getDb } from './db'
import { oauthClient, oauthConsent, oauthRefreshToken } from './db/schema'

export type ClientRow = {
  clientId: string
  name: string | null
  redirectUris: string[]
  createdAt: Date | null
  disabled: boolean
  hasConsent: boolean
  activeTokens: number
}

export type TokenRow = {
  id: string
  tokenTail: string
  clientId: string
  clientName: string | null
  createdAt: Date
  expiresAt: Date
}

function activeRefreshTokens(now: Date) {
  return and(isNull(oauthRefreshToken.revoked), isNull(oauthRefreshToken.rotatedAt), gt(oauthRefreshToken.expiresAt, now))
}

export function listClients(): ClientRow[] {
  const db = getDb()
  const now = new Date()
  const clients = db.select().from(oauthClient).orderBy(desc(oauthClient.createdAt)).all()
  return clients.map((c) => {
    const consent = db.select({ n: count() }).from(oauthConsent).where(eq(oauthConsent.clientId, c.clientId)).get()
    const tokens = db
      .select({ n: count() })
      .from(oauthRefreshToken)
      .where(and(eq(oauthRefreshToken.clientId, c.clientId), activeRefreshTokens(now)))
      .get()
    return {
      clientId: c.clientId,
      name: c.name,
      redirectUris: Array.isArray(c.redirectUris) ? (c.redirectUris as string[]) : [],
      createdAt: c.createdAt,
      disabled: !!c.disabled,
      hasConsent: (consent?.n ?? 0) > 0,
      activeTokens: tokens?.n ?? 0,
    }
  })
}

export function listActiveTokens(): TokenRow[] {
  return getDb()
    .select({
      id: oauthRefreshToken.id,
      token: oauthRefreshToken.token,
      clientId: oauthRefreshToken.clientId,
      clientName: oauthClient.name,
      createdAt: oauthRefreshToken.createdAt,
      expiresAt: oauthRefreshToken.expiresAt,
    })
    .from(oauthRefreshToken)
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthRefreshToken.clientId))
    .where(activeRefreshTokens(new Date()))
    .orderBy(desc(oauthRefreshToken.createdAt))
    .all()
    .map(({ token, ...row }) => ({ ...row, tokenTail: token.slice(-4) }))
}

export function isMcpConnected(): boolean {
  const row = getDb().select({ n: count() }).from(oauthRefreshToken).where(activeRefreshTokens(new Date())).get()
  return (row?.n ?? 0) > 0
}

/** Deletes the client with its consents and tokens; /api/mcp rejects its JWTs immediately. */
export function revokeClient(clientId: string): void {
  getDb().delete(oauthClient).where(eq(oauthClient.clientId, clientId)).run()
}

/** Stops the refresh token; the current access token lives out its hour unless the client is revoked. */
export function revokeToken(id: string): void {
  getDb().update(oauthRefreshToken).set({ revoked: new Date() }).where(eq(oauthRefreshToken.id, id)).run()
}

export function revokeAllClients(): void {
  getDb().delete(oauthClient).run()
}
