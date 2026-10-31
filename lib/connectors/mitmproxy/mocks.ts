import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { mitmMock } from '../../db/schema'
import { logger } from '../../logger'
import { getConnector } from '../registry'
import { getConnectorRow, readConfig } from '../store'
import { ToolError } from '../types'
import { MitmClient } from './client'
import { payloadFor, type MockRule } from './rules'

type RuleBody = Omit<MockRule, 'id' | 'enabled' | 'name'>
type MockInput = Omit<MockRule, 'id' | 'enabled'> & { id?: string }

export class AddonMissingError extends ToolError {}

type Row = typeof mitmMock.$inferSelect

function toRule(row: Row): MockRule {
  return { ...(JSON.parse(row.ruleJson) as RuleBody), id: row.id, name: row.name, enabled: row.enabled }
}

function getRow(id: string): Row {
  const row = getDb().select().from(mitmMock).where(eq(mitmMock.id, id)).get()
  if (!row) throw new ToolError(`Правила ${id} нет`)
  return row
}

export function listMocks(): MockRule[] {
  return getDb().select().from(mitmMock).all().map(toRule)
}

/** New rules start enabled; saving with an existing id replaces the rule and keeps its enabled flag. */
export function saveMock(input: MockInput): MockRule {
  const { id: given, name, ...rest } = input
  const body: Record<string, unknown> = { ...rest }
  delete body.enabled
  const ruleJson = JSON.stringify(body)
  const now = new Date()
  const existing = given ? getDb().select().from(mitmMock).where(eq(mitmMock.id, given)).get() : undefined
  if (existing) {
    getDb().update(mitmMock).set({ name, ruleJson, updatedAt: now }).where(eq(mitmMock.id, existing.id)).run()
    return toRule(getRow(existing.id))
  }
  const id = given ?? randomUUID().slice(0, 8)
  getDb().insert(mitmMock).values({ id, name, enabled: true, ruleJson, createdAt: now, updatedAt: now }).run()
  return toRule(getRow(id))
}

export function setMockEnabled(id: string, enabled: boolean): MockRule {
  getRow(id)
  getDb().update(mitmMock).set({ enabled, updatedAt: new Date() }).where(eq(mitmMock.id, id)).run()
  return toRule(getRow(id))
}

export function deleteMock(id: string): void {
  getDb().delete(mitmMock).where(eq(mitmMock.id, id)).run()
}

export function deleteAllMocks(): number {
  return getDb().delete(mitmMock).run().changes
}

const ADDON_MISSING =
  'В mitmproxy не подключён аддон hub_mocks.py: положи его в Docker/mitmproxy/scripts/ и добавь `-s /scripts/hub_mocks.py` в command'

// Last known reachability, so a down proxy is logged once rather than every minute.
let reachable = true

/** Push the desired rules if the proxy differs. Non-strict mode never throws (used by the cron job). */
export async function syncMocks(opts: { strict?: boolean } = {}): Promise<'in-sync' | 'pushed' | 'skipped'> {
  const connector = getConnector('mitmproxy')
  const row = getConnectorRow('mitmproxy')
  if (!connector || !row) return 'skipped'
  const parsed = connector.parseConfig(readConfig(connector, row))
  if (!parsed.ok) return 'skipped'
  const config = parsed.config as { baseUrl: string; password?: string; timeoutSec: number; allowMocks: boolean }

  const desired = row.enabled && config.allowMocks ? payloadFor(listMocks()) : payloadFor([])
  const client = new MitmClient({ baseUrl: config.baseUrl, password: config.password, timeoutSec: config.timeoutSec })
  try {
    const options = await client.options()
    reachable = true
    const current = options.hub_mocks
    if (!current) throw new AddonMissingError(ADDON_MISSING)
    if (current.value === desired) return 'in-sync'
    await client.setOptions({ hub_mocks: desired })
    return 'pushed'
  } catch (e) {
    if (opts.strict) throw e
    if (e instanceof AddonMissingError) return 'skipped'
    if (reachable) logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'mitmproxy unreachable, mocks not synced')
    reachable = false
    return 'skipped'
  }
}
