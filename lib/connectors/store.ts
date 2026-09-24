import { eq } from 'drizzle-orm'
import { decryptSecret, encryptSecret, isEncrypted } from '../crypto'
import { getDb } from '../db'
import { connector as connectorTable } from '../db/schema'
import { logger } from '../logger'
import { fieldRegistry, type RegisteredConnector, type TestResult } from './types'

export type ConnectorRow = typeof connectorTable.$inferSelect

export function secretFields(c: RegisteredConnector): string[] {
  return Object.entries(c.shape)
    .filter(([, schema]) => fieldRegistry.get(schema)?.secret)
    .map(([key]) => key)
}

export function getConnectorRow(id: string): ConnectorRow | undefined {
  return getDb().select().from(connectorTable).where(eq(connectorTable.id, id)).get()
}

export function listConnectorRows(): ConnectorRow[] {
  return getDb().select().from(connectorTable).all()
}

/** Raw stored config with secrets decrypted. Only for calling the service. */
export function readConfig(c: RegisteredConnector, row: ConnectorRow | undefined = getConnectorRow(c.id)): Record<string, unknown> | null {
  if (!row) return null
  const stored = JSON.parse(row.configEnc) as Record<string, unknown>
  for (const key of secretFields(c)) {
    const v = stored[key]
    if (isEncrypted(v)) {
      try {
        stored[key] = decryptSecret(v)
      } catch {
        // Master key changed: the secret has to be entered again.
        logger.warn({ connector: c.id, field: key }, 'cannot decrypt connector secret')
        delete stored[key]
      }
    }
  }
  return stored
}

/** Which secrets are stored, for «задан, изменить» in the form. Never returns values. */
export function storedSecretFlags(c: RegisteredConnector, row: ConnectorRow | undefined): Record<string, boolean> {
  const stored = row ? (JSON.parse(row.configEnc) as Record<string, unknown>) : {}
  return Object.fromEntries(secretFields(c).map((k) => [k, typeof stored[k] === 'string' && stored[k] !== '']))
}

/**
 * Merge submitted form values with stored secrets: an empty secret field means
 * «keep the current value».
 */
export function mergeWithStoredSecrets(c: RegisteredConnector, submitted: Record<string, unknown>): Record<string, unknown> {
  const current = readConfig(c) ?? {}
  const merged = { ...submitted }
  for (const key of secretFields(c)) {
    const v = merged[key]
    if (v === undefined || v === '') {
      if (current[key] !== undefined) merged[key] = current[key]
      else delete merged[key]
    }
  }
  return merged
}

export function saveConfig(c: RegisteredConnector, config: Record<string, unknown>): void {
  const toStore: Record<string, unknown> = { ...config }
  for (const key of secretFields(c)) {
    const v = toStore[key]
    if (typeof v === 'string' && v !== '') toStore[key] = encryptSecret(v)
    else delete toStore[key]
  }
  const now = new Date()
  const values = {
    id: c.id,
    type: c.id,
    name: c.name,
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : null,
    configEnc: JSON.stringify(toStore),
    updatedAt: now,
  }
  getDb()
    .insert(connectorTable)
    .values({ ...values, enabled: true, disabledTools: [] })
    .onConflictDoUpdate({ target: connectorTable.id, set: values })
    .run()
}

export function setConnectorEnabled(id: string, enabled: boolean): void {
  getDb().update(connectorTable).set({ enabled, updatedAt: new Date() }).where(eq(connectorTable.id, id)).run()
}

export function setDisabledTools(id: string, disabledTools: string[]): void {
  getDb().update(connectorTable).set({ disabledTools, updatedAt: new Date() }).where(eq(connectorTable.id, id)).run()
}

export function recordCheck(id: string, result: TestResult): void {
  const note = [result.summary, ...result.details].join(' · ').slice(0, 300)
  getDb()
    .update(connectorTable)
    .set({ lastCheckAt: new Date(), lastCheckOk: result.ok, lastCheckNote: note })
    .where(eq(connectorTable.id, id))
    .run()
}
