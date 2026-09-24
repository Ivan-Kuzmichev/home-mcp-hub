import { and, count, desc, eq, gte, like, lt, or, sql, type SQL } from 'drizzle-orm'
import { scrub } from './connectors/http'
import { getDb } from './db'
import { toolCall } from './db/schema'
import { logger } from './logger'

export type JournalRow = typeof toolCall.$inferSelect

export const JOURNAL_RETENTION_DAYS = 30
const MAX_ARGS = 500
const MAX_SUMMARY = 160

const SECRET_KEYS = /^(password|pass|api_?key|apikey|token|secret|access_token|refresh_token|code_verifier)$/i

function describeValue(key: string, value: unknown): string | null {
  if (SECRET_KEYS.test(key)) return null
  if (key === 'pin') return value ? 'задан' : 'нет'
  // Prototype HTML never goes into the journal.
  if (key === 'html' && typeof value === 'string') return `HTML ${Math.max(1, Math.round(Buffer.byteLength(value) / 1024))} КБ`
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return key === 'query' || key === 'title' ? `«${value.slice(0, 120)}»` : value.slice(0, 120)
  if (Array.isArray(value)) return value.map((v) => String(v).slice(0, 40)).join(', ')
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 120)
  return String(value)
}

/** «query: «Severance», type: tv, limit: 10» — secrets dropped, HTML replaced by its size. */
export function redactArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '—'
  const parts = Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => {
      const d = describeValue(k, v)
      return d === null ? null : `${k}: ${d}`
    })
    .filter((p): p is string => !!p)
  const text = scrub(parts.join(', ')) || '—'
  return text.length > MAX_ARGS ? `${text.slice(0, MAX_ARGS - 1)}…` : text
}

export function summarize(text: string): string {
  const first = scrub(text.split('\n')[0] ?? '').trim()
  return first.length > MAX_SUMMARY ? `${first.slice(0, MAX_SUMMARY - 1)}…` : first
}

function insert(row: Omit<JournalRow, 'id'>): void {
  try {
    getDb().insert(toolCall).values(row).run()
  } catch (e) {
    // The journal must never break a tool call.
    logger.error({ err: e instanceof Error ? e.message : String(e) }, 'journal write failed')
  }
}

export function logToolCall(e: {
  tool: string
  connectorId: string
  args: unknown
  ok: boolean
  result?: string
  error?: string
  durationMs: number
  clientId?: string | null
  ip?: string | null
}): void {
  insert({
    tool: e.tool,
    connectorId: e.connectorId,
    argsRedacted: redactArgs(e.args),
    ok: e.ok,
    resultSummary: e.result ? summarize(e.result) : null,
    error: e.error ? summarize(e.error) : null,
    durationMs: e.durationMs,
    clientId: e.clientId ?? null,
    ip: e.ip ?? null,
    createdAt: new Date(),
  })
  logger.info({ tool: e.tool, ok: e.ok, ms: e.durationMs }, 'tool call')
}

export type AuthEvent = 'auth.password' | 'auth.second_factor' | 'auth.consent'

export const AUTH_EVENT_LABELS: Record<AuthEvent, string> = {
  'auth.password': 'вход: пароль',
  'auth.second_factor': 'вход в админку',
  'auth.consent': 'доступ для Claude',
}

export function logAuthEvent(e: { event: AuthEvent; ok: boolean; detail: string; error?: string; ip?: string | null }): void {
  insert({
    tool: e.event,
    connectorId: 'auth',
    argsRedacted: scrub(e.detail).slice(0, MAX_ARGS),
    ok: e.ok,
    resultSummary: null,
    error: e.error ?? null,
    durationMs: null,
    clientId: null,
    ip: e.ip ?? null,
    createdAt: new Date(),
  })
  logger.info({ event: e.event, ok: e.ok }, 'auth event')
}

// ---------------------------------------------------------------------------
// Queries for the admin panel

export type JournalFilter = {
  connector?: string
  status?: 'ok' | 'error'
  periodDays?: number
  q?: string
}

function where(f: JournalFilter): SQL | undefined {
  const conds: SQL[] = []
  if (f.connector) conds.push(eq(toolCall.connectorId, f.connector))
  if (f.status) conds.push(eq(toolCall.ok, f.status === 'ok'))
  if (f.periodDays) conds.push(gte(toolCall.createdAt, new Date(Date.now() - f.periodDays * 86_400_000)))
  if (f.q) {
    const pattern = `%${f.q.replace(/[%_]/g, '')}%`
    conds.push(or(like(toolCall.tool, pattern), like(toolCall.argsRedacted, pattern), like(toolCall.resultSummary, pattern))!)
  }
  return conds.length ? and(...conds) : undefined
}

export function queryJournal(f: JournalFilter, limit = 100, offset = 0): JournalRow[] {
  return getDb().select().from(toolCall).where(where(f)).orderBy(desc(toolCall.createdAt), desc(toolCall.id)).limit(limit).offset(offset).all()
}

export function countJournal(f: JournalFilter): { total: number; errors: number } {
  const row = getDb()
    .select({ total: count(), errors: sql<number>`sum(case when ${toolCall.ok} = 0 then 1 else 0 end)` })
    .from(toolCall)
    .where(where(f))
    .get()
  return { total: row?.total ?? 0, errors: Number(row?.errors ?? 0) }
}

export function recentToolCalls(limit = 5): JournalRow[] {
  return getDb().select().from(toolCall).where(sql`${toolCall.connectorId} <> 'auth'`).orderBy(desc(toolCall.createdAt), desc(toolCall.id)).limit(limit).all()
}

export function lastCallByClient(clientId: string): JournalRow | undefined {
  return getDb().select().from(toolCall).where(eq(toolCall.clientId, clientId)).orderBy(desc(toolCall.createdAt)).limit(1).get()
}

export function lastToolCall(): JournalRow | undefined {
  return recentToolCalls(1)[0]
}

export function failedSignIns(since: Date): number {
  return (
    getDb()
      .select({ n: count() })
      .from(toolCall)
      .where(and(eq(toolCall.connectorId, 'auth'), eq(toolCall.ok, false), gte(toolCall.createdAt, since)))
      .get()?.n ?? 0
  )
}

export function purgeJournal(days = JOURNAL_RETENTION_DAYS): number {
  return getDb().delete(toolCall).where(lt(toolCall.createdAt, new Date(Date.now() - days * 86_400_000))).run().changes
}
