import { getQuickJS, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten'
import { and, count, eq } from 'drizzle-orm'
import { fetch as undiciFetch } from 'undici'
import { getDb } from '../db'
import { scriptState } from '../db/schema'
import { assertPublicUrl, NetworkPolicyError, scriptAgent } from './net'
import { SecretPolicyError, SecretVault } from './secrets'

export const LIMITS = {
  timeMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  fetches: 20,
  fetchTimeoutMs: 15_000,
  responseBytes: 1024 * 1024,
  logBytes: 20 * 1024,
  outputBytes: 10 * 1024,
  stateKeys: 100,
  stateValueBytes: 64 * 1024,
}

/** What the model reads before writing a script (cron_create description). */
export const SANDBOX_API_DOC = `Код — тело async-функции (можно await и return). Доступно:
- await fetch(url, { method, headers, body }) → { status, ok, headers, text, json() }. body — строка или объект (уйдёт как JSON). Редиректы не выполняются сами (3xx вернётся как есть). Только внешние адреса: локальная сеть закрыта.
- Секреты — только заглушками {{secret:ИМЯ}} в url, headers или body; хаб подставит значение, если адрес совпадает с хостами секрета. Значение секрета скрипту недоступно. Список — cron_secrets.
- log(...значения) — в журнал запуска.
- state.get(key), state.set(key, value) — память между запусками (JSON).
- await hub.tool(имя, аргументы) — инструменты хаба только для чтения (torrents_status, search_torrents, paperless_search…), возвращают текст.
- return значение — результат запуска.
Нет: require/import, process, файлов, таймеров. Лимиты: 30 с, 64 МБ, ${LIMITS.fetches} запросов, ответ до 1 МБ.`

export type RunResult = { ok: boolean; output: string | null; logs: string[]; error: string | null; durationMs: number; fetches: number }

export type SandboxDeps = {
  /** fetch implementation (tests); defaults to undici with the private-network guard */
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>
  /** Hub read-only tools; injected to avoid an import cycle with the connector registry */
  callTool?: (name: string, args: unknown) => Promise<string>
  vault?: SecretVault
}

// Friendly wrappers over the raw host functions.
const PRELUDE = `
globalThis.fetch = async (url, opts) => {
  const raw = await __fetch(String(url), JSON.stringify(opts || {}));
  const r = JSON.parse(raw);
  r.json = () => JSON.parse(r.text);
  return r;
};
globalThis.log = (...args) => __log(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
globalThis.console = { log: globalThis.log, error: globalThis.log, warn: globalThis.log };
globalThis.state = {
  get: (key) => { const v = __stateGet(String(key)); return v === undefined ? undefined : JSON.parse(v); },
  set: (key, value) => { __stateSet(String(key), JSON.stringify(value === undefined ? null : value)); },
};
globalThis.hub = { tool: (name, args) => __tool(String(name), JSON.stringify(args || {})) };
`

function cap(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text
  return `${Buffer.from(text).subarray(0, bytes).toString('utf8')}… (обрезано)`
}

async function readCapped(res: Response, limit: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      throw new Error(`Ответ больше ${limit / 1024 / 1024} МБ`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function errorText(ctx: QuickJSContext, handle: QuickJSHandle): string {
  const e = ctx.dump(handle) as { name?: string; message?: string; stack?: string } | string
  if (typeof e !== 'object' || e === null) return String(e)
  if (e.message === 'interrupted') return `Превышено время выполнения (${LIMITS.timeMs / 1000} с)`
  const where = /eval\.js:(\d+)/.exec(e.stack ?? '')?.[1]
  return `${e.name ?? 'Error'}: ${e.message ?? ''}${where ? ` (строка ${Math.max(1, Number(where) - 1)})` : ''}`
}

/** Checks syntax without running anything. Returns the error text or null. */
export async function checkSyntax(code: string): Promise<string | null> {
  const QJS = await getQuickJS()
  const ctx = QJS.newContext()
  try {
    // Wrapped in a never-called function: parsing only.
    const r = ctx.evalCode(`(async function () {\n${code}\n})`)
    if (r.error) {
      const msg = errorText(ctx, r.error)
      r.error.dispose()
      return msg
    }
    r.value.dispose()
    return null
  } finally {
    ctx.dispose()
  }
}

export async function runScript(scriptId: string, code: string, deps: SandboxDeps = {}): Promise<RunResult> {
  const started = Date.now()
  const deadline = started + LIMITS.timeMs
  const vault = deps.vault ?? new SecretVault()
  const logs: string[] = []
  let logBytes = 0
  let fetches = 0

  const QJS = await getQuickJS()
  const rt = QJS.newRuntime()
  rt.setMemoryLimit(LIMITS.memoryBytes)
  rt.setMaxStackSize(1024 * 1024)
  rt.setInterruptHandler(() => Date.now() > deadline)
  const ctx = rt.newContext()
  const pending = new Set<Promise<unknown>>()
  const abort = new AbortController()

  /** Host async function: returns a QuickJS promise settled from a host promise. */
  const asyncFn = (name: string, impl: (...args: string[]) => Promise<string>) => {
    const fn = ctx.newFunction(name, (...handles) => {
      const args = handles.map((h) => ctx.getString(h))
      const deferred = ctx.newPromise()
      const p = impl(...args).then(
        (value) => {
          if (!ctx.alive) return
          const v = ctx.newString(value)
          deferred.resolve(v)
          v.dispose()
        },
        (error: unknown) => {
          if (!ctx.alive) return
          const e = ctx.newError(vault.redact(error instanceof Error ? error.message : String(error)))
          deferred.reject(e)
          e.dispose()
        },
      )
      pending.add(p)
      void p.finally(() => pending.delete(p))
      void deferred.settled.then(() => ctx.alive && rt.executePendingJobs())
      return deferred.handle
    })
    ctx.setProp(ctx.global, name, fn)
    fn.dispose()
  }
  const syncFn = (name: string, impl: (...args: string[]) => string | undefined) => {
    const fn = ctx.newFunction(name, (...handles) => {
      try {
        const out = impl(...handles.map((h) => ctx.getString(h)))
        return out === undefined ? ctx.undefined : ctx.newString(out)
      } catch (error) {
        return { error: ctx.newError(error instanceof Error ? error.message : String(error)) }
      }
    })
    ctx.setProp(ctx.global, name, fn)
    fn.dispose()
  }

  asyncFn('__fetch', async (rawUrl, optsJson) => {
    if (++fetches > LIMITS.fetches) throw new Error(`Больше ${LIMITS.fetches} запросов за запуск`)
    const opts = JSON.parse(optsJson) as { method?: string; headers?: Record<string, unknown>; body?: unknown }
    // Host is fixed before secrets go in: a placeholder cannot change where the request goes.
    const host = assertPublicUrl(rawUrl.replace(/\{\{secret:[A-Z0-9_]+\}\}/g, 'x')).hostname
    const url = vault.substitute(rawUrl, host)
    if (assertPublicUrl(url).hostname !== host) throw new SecretPolicyError('Секрет не может менять адрес запроса')
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k] = vault.substitute(String(v), host)
    let body: string | undefined
    if (opts.body !== undefined && opts.body !== null) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
      if (typeof opts.body !== 'string' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
      body = vault.substitute(body, host)
    }
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.min(LIMITS.fetchTimeoutMs, Math.max(1, deadline - Date.now())))])
    const init = { method: (opts.method ?? 'GET').toUpperCase(), headers, body, redirect: 'manual' as const, signal }
    let res: Response
    try {
      res = deps.fetchImpl ? await deps.fetchImpl(url, init) : ((await undiciFetch(url, { ...init, dispatcher: scriptAgent })) as unknown as Response)
    } catch (error) {
      const cause = (error as { cause?: Error }).cause
      if (cause && (cause instanceof NetworkPolicyError || (cause as { code?: string }).code === 'EPOLICY')) throw new NetworkPolicyError(cause.message)
      throw new Error(`${host}: ${cause?.message ?? (error instanceof Error ? error.message : String(error))}`)
    }
    const text = await readCapped(res, LIMITS.responseBytes)
    return JSON.stringify({ status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), text })
  })

  syncFn('__log', (line) => {
    const safe = vault.redact(line)
    logBytes += Buffer.byteLength(safe)
    if (logBytes <= LIMITS.logBytes) logs.push(safe)
    return undefined
  })

  const db = getDb()
  syncFn('__stateGet', (key) => db.select().from(scriptState).where(and(eq(scriptState.scriptId, scriptId), eq(scriptState.key, key))).get()?.valueJson)
  syncFn('__stateSet', (key, valueJson) => {
    if (Buffer.byteLength(valueJson) > LIMITS.stateValueBytes) throw new Error('state: значение больше 64 КБ')
    const exists = db.select().from(scriptState).where(and(eq(scriptState.scriptId, scriptId), eq(scriptState.key, key))).get()
    if (!exists) {
      const n = db.select({ n: count() }).from(scriptState).where(eq(scriptState.scriptId, scriptId)).get()?.n ?? 0
      if (n >= LIMITS.stateKeys) throw new Error(`state: больше ${LIMITS.stateKeys} ключей`)
    }
    db.insert(scriptState).values({ scriptId, key, valueJson }).onConflictDoUpdate({ target: [scriptState.scriptId, scriptState.key], set: { valueJson } }).run()
    return undefined
  })

  asyncFn('__tool', async (name, argsJson) => {
    if (!deps.callTool) throw new Error('hub.tool недоступен')
    return deps.callTool(name, JSON.parse(argsJson))
  })

  let result: RunResult
  try {
    const prelude = ctx.evalCode(PRELUDE)
    if (prelude.error) throw new Error(errorText(ctx, prelude.error))
    prelude.value.dispose()

    const evaluated = ctx.evalCode(`(async () => {\n${code}\n})()`)
    if (evaluated.error) {
      const msg = errorText(ctx, evaluated.error)
      evaluated.error.dispose()
      throw new Error(msg)
    }
    const settled = ctx.resolvePromise(evaluated.value)
    evaluated.value.dispose()
    rt.executePendingJobs()
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now()) + 50))
    const outcome = await Promise.race([settled, timeout])
    if (outcome === 'timeout') throw new Error(`Превышено время выполнения (${LIMITS.timeMs / 1000} с)`)
    if (outcome.error) {
      const msg = errorText(ctx, outcome.error)
      outcome.error.dispose()
      throw new Error(msg)
    }
    const value: unknown = ctx.dump(outcome.value)
    outcome.value.dispose()
    const output = value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    result = { ok: true, output: output === null ? null : cap(vault.redact(output), LIMITS.outputBytes), logs, error: null, durationMs: Date.now() - started, fetches }
  } catch (error) {
    result = { ok: false, output: null, logs, error: vault.redact(error instanceof Error ? error.message : String(error)), durationMs: Date.now() - started, fetches }
  } finally {
    abort.abort()
    await Promise.allSettled([...pending])
    try {
      ctx.dispose()
      rt.dispose()
    } catch {
      // Handles leaked by an interrupted script: the runtime is dropped with the run anyway.
    }
  }
  return result
}
