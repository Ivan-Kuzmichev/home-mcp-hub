import { createHash, randomInt } from 'node:crypto'
import { and, desc, eq, lt, notInArray } from 'drizzle-orm'
import cron from 'node-cron'
import { getDb } from '../db'
import { script, scriptRun } from '../db/schema'
import { checkSyntax, type RunResult } from './sandbox'
import { normalizeSpec, toolNameOf, type ToolParam, type ToolSpec } from './tool-spec'

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

/** The approved unit: code alone for cron, code plus parameters and read-only flag for a tool. */
export const versionHash = (code: string, spec: ToolSpec | null) => (spec ? hashCode(`${code}\n${JSON.stringify(spec)}`) : hashCode(code))

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
    kind: 'cron' as const,
    schedule,
    code: input.code,
    codeHash: hashCode(input.code),
    spec: null,
    approvedSpec: null,
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

function assertFreeName(name: string): void {
  if (listScripts().some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new ScriptError(`«${name}» уже есть — меняй через ${name.startsWith('my_') ? 'tool_update' : 'cron_update'}`)
}

export async function createTool(input: { name: string; description: string; params: ToolParam[]; readOnly: boolean; code: string }): Promise<Script> {
  let name: string
  let spec: ToolSpec
  try {
    name = toolNameOf(input.name)
    spec = normalizeSpec(input.params, input.readOnly)
  } catch (e) {
    throw new ScriptError(e instanceof Error ? e.message : String(e))
  }
  assertFreeName(name)
  if (!input.description.trim()) throw new ScriptError('Нужно описание — по нему ассистент решает, когда вызывать инструмент')
  await checkCode(input.code)
  const now = new Date()
  const row: Script = {
    id: newId(),
    name,
    description: input.description.slice(0, 1000),
    kind: 'tool',
    schedule: '',
    code: input.code,
    codeHash: versionHash(input.code, spec),
    spec,
    approvedSpec: null,
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

export type ScriptChange = { name?: string; description?: string; schedule?: string; code?: string; params?: ToolParam[]; readOnly?: boolean }

/** A new version (code, or a tool's parameters) needs a new approval and pauses the script; name/description/schedule do not. */
export async function updateScript(s: Script, change: ScriptChange): Promise<Script> {
  try {
    return await applyChange(s, change)
  } catch (e) {
    if (e instanceof ScriptError || !(e instanceof Error)) throw e
    throw new ScriptError(e.message)
  }
}

async function applyChange(s: Script, change: ScriptChange): Promise<Script> {
  const set: Partial<Script> = { updatedAt: new Date() }
  if (change.name !== undefined) {
    const name = s.kind === 'tool' ? toolNameOf(change.name) : change.name.trim().slice(0, 80) || s.name
    if (name !== s.name) assertFreeName(name)
    set.name = name
  }
  if (change.description !== undefined) set.description = change.description.slice(0, s.kind === 'tool' ? 1000 : 500)
  if (change.schedule !== undefined && s.kind === 'cron') set.schedule = validateSchedule(change.schedule)
  const code = change.code ?? s.code
  const spec = s.kind === 'tool' && s.spec ? normalizeSpec(change.params ?? s.spec.params, change.readOnly ?? s.spec.readOnly) : null
  const hash = versionHash(code, spec)
  if (hash !== s.codeHash) {
    if (change.code !== undefined) await checkCode(change.code)
    set.code = code
    set.spec = spec
    set.codeHash = hash
    if (hash !== s.approvedHash) set.enabled = false
  }
  getDb().update(script).set(set).where(eq(script.id, s.id)).run()
  return { ...s, ...set }
}

/** Admin only: approves exactly this code (by hash) and switches the script on. */
export function approveScript(id: string, codeHash: string): void {
  const s = getScript(id)
  if (!s) throw new ScriptError('Скрипт не найден')
  if (s.codeHash !== codeHash) throw new ScriptError('Код изменился, пока ты смотрел — открой заново')
  getDb()
    .update(script)
    .set({ approvedHash: s.codeHash, approvedCode: s.code, approvedSpec: s.spec, approvedAt: new Date(), rejectedHash: null, rejectReason: null, enabled: true })
    .where(eq(script.id, id))
    .run()
}

/**
 * Admin only: a rejected new script is deleted; a rejected change of an approved script is
 * dropped, and the script goes back to its approved code and runs again.
 */
export function rejectScript(id: string, codeHash: string): 'deleted' | 'reverted' {
  const s = getScript(id)
  if (!s) throw new ScriptError('Скрипт не найден')
  if (s.codeHash !== codeHash) throw new ScriptError('Код изменился, пока ты смотрел — открой заново')
  if (!s.approvedHash || s.approvedCode === null) {
    deleteScript(id)
    return 'deleted'
  }
  getDb()
    .update(script)
    .set({ code: s.approvedCode, spec: s.approvedSpec, codeHash: s.approvedHash, rejectedHash: null, rejectReason: null, enabled: true, updatedAt: new Date() })
    .where(eq(script.id, id))
    .run()
  return 'reverted'
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
