import { createHash, randomInt } from 'node:crypto'
import { and, desc, eq, lt, notInArray } from 'drizzle-orm'
import cron from 'node-cron'
import { getDb } from '../db'
import { script, scriptRun } from '../db/schema'
import { checkSyntax, type RunResult } from './sandbox'

export type Script = typeof script.$inferSelect
export type ScriptStatus = 'pending' | 'rejected' | 'approved' | 'active'

export class ScriptError extends Error {}

export const MAX_CODE_BYTES = 32 * 1024
/** Every minute is the finest schedule; seconds-level patterns are refused. */
export function validateSchedule(expr: string): string {
  const e = expr.trim().replace(/\s+/g, ' ')
  if (e.split(' ').length !== 5) throw new ScriptError('Расписание — 5 полей cron: минута час день месяц день_недели, например «0 9 * * *»')
  if (!cron.validate(e)) throw new ScriptError(`Неверное cron-выражение «${e}»`)
  return e
}

export function nextRun(expr: string): Date | null {
  try {
    // getNextRun() is null until a task is started; getNextRuns() works on an idle one.
    const task = cron.createTask(expr, () => undefined)
    const next = task.getNextRuns(1)[0] ?? null
    void task.destroy()
    return next
  } catch {
    return null
  }
}

export const hashCode = (code: string) => createHash('sha256').update(code).digest('hex')

export function statusOf(s: Script): ScriptStatus {
  if (s.approvedHash !== s.codeHash) return s.rejectedHash === s.codeHash ? 'rejected' : 'pending'
  return s.enabled ? 'active' : 'approved'
}

export const STATUS_LABELS: Record<ScriptStatus, string> = {
  pending: 'ждёт одобрения',
  rejected: 'отклонён',
  approved: 'одобрен, выключен',
  active: 'включён',
}

function newId(): string {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789'
  let s = 'sc_'
  for (let i = 0; i < 6; i++) s += a[randomInt(a.length)]
  return s
}

async function checkCode(code: string): Promise<void> {
  if (!code.trim()) throw new ScriptError('Пустой код')
  if (Buffer.byteLength(code) > MAX_CODE_BYTES) throw new ScriptError('Код больше 32 КБ')
  const err = await checkSyntax(code)
  if (err) throw new ScriptError(`Ошибка в коде: ${err}`)
}

export function listScripts(): Script[] {
  return getDb().select().from(script).orderBy(desc(script.updatedAt)).all()
}

export function getScript(id: string): Script | undefined {
  return getDb().select().from(script).where(eq(script.id, id)).get()
}

export function findScript(ref: string): Script {
  const s = getScript(ref.trim()) ?? listScripts().find((x) => x.name.toLowerCase() === ref.trim().toLowerCase())
  if (!s) throw new ScriptError(`Скрипт «${ref}» не найден — cron_list`)
  return s
}

export async function createScript(input: { name: string; description?: string; schedule: string; code: string }): Promise<Script> {
  const name = input.name.trim().slice(0, 80)
  if (!name) throw new ScriptError('Нужно имя')
  if (listScripts().some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new ScriptError(`Скрипт «${name}» уже есть — меняй его через cron_update`)
  const schedule = validateSchedule(input.schedule)
  await checkCode(input.code)
  const now = new Date()
  const row = {
    id: newId(),
    name,
    description: (input.description ?? '').slice(0, 500),
    schedule,
    code: input.code,
    codeHash: hashCode(input.code),
    approvedHash: null,
    approvedCode: null,
    approvedAt: null,
    rejectedHash: null,
    rejectReason: null,
    enabled: false,
    lastRunAt: null,
    lastRunOk: null,
    createdAt: now,
    updatedAt: now,
  }
  getDb().insert(script).values(row).run()
  return row
}

/** A code change needs a new approval and pauses the script; name/description/schedule do not. */
export async function updateScript(s: Script, change: { name?: string; description?: string; schedule?: string; code?: string }): Promise<Script> {
  const set: Partial<Script> = { updatedAt: new Date() }
  if (change.name !== undefined) set.name = change.name.trim().slice(0, 80) || s.name
  if (change.description !== undefined) set.description = change.description.slice(0, 500)
  if (change.schedule !== undefined) set.schedule = validateSchedule(change.schedule)
  if (change.code !== undefined && hashCode(change.code) !== s.codeHash) {
    await checkCode(change.code)
    set.code = change.code
    set.codeHash = hashCode(change.code)
    if (set.codeHash !== s.approvedHash) set.enabled = false
  }
  getDb().update(script).set(set).where(eq(script.id, s.id)).run()
  return { ...s, ...set }
}

/** Admin only: approves exactly this code (by hash). Enabling stays a separate step. */
export function approveScript(id: string, codeHash: string): void {
  const s = getScript(id)
  if (!s) throw new ScriptError('Скрипт не найден')
  if (s.codeHash !== codeHash) throw new ScriptError('Код изменился, пока ты смотрел — открой заново')
  getDb().update(script).set({ approvedHash: s.codeHash, approvedCode: s.code, approvedAt: new Date(), rejectedHash: null, rejectReason: null }).where(eq(script.id, id)).run()
}

export function rejectScript(id: string, codeHash: string, reason: string): void {
  getDb().update(script).set({ rejectedHash: codeHash, rejectReason: reason.slice(0, 500) || null, enabled: false }).where(and(eq(script.id, id), eq(script.codeHash, codeHash))).run()
}

export function setScriptEnabled(s: Script, enabled: boolean): void {
  if (enabled && s.approvedHash !== s.codeHash) throw new ScriptError('Этот код ещё не одобрен в админке — включить нельзя')
  getDb().update(script).set({ enabled, updatedAt: new Date() }).where(eq(script.id, s.id)).run()
}

export function deleteScript(id: string): void {
  getDb().delete(script).where(eq(script.id, id)).run()
}

export function recordRun(s: Script, trigger: string, r: RunResult): void {
  const db = getDb()
  const started = new Date(Date.now() - r.durationMs)
  db.insert(scriptRun)
    .values({ scriptId: s.id, trigger, ok: r.ok, output: r.output, logs: r.logs.length ? r.logs.join('\n') : null, error: r.error, durationMs: r.durationMs, startedAt: started })
    .run()
  db.update(script).set({ lastRunAt: started, lastRunOk: r.ok }).where(eq(script.id, s.id)).run()
  // Keep the last 50 runs per script.
  const keep = db.select({ id: scriptRun.id }).from(scriptRun).where(eq(scriptRun.scriptId, s.id)).orderBy(desc(scriptRun.id)).limit(50).all().map((x) => x.id)
  if (keep.length === 50) db.delete(scriptRun).where(and(eq(scriptRun.scriptId, s.id), notInArray(scriptRun.id, keep))).run()
}

export function listRuns(scriptId: string, limit = 10) {
  return getDb().select().from(scriptRun).where(eq(scriptRun.scriptId, scriptId)).orderBy(desc(scriptRun.id)).limit(limit).all()
}

export function purgeOldRuns(days = 30): number {
  return getDb().delete(scriptRun).where(lt(scriptRun.startedAt, new Date(Date.now() - days * 86_400_000))).run().changes
}
