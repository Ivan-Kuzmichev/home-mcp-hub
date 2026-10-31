import { z } from 'zod'

/**
 * Declarative mock rules shared with the Python mitmproxy addon: the addon applies exactly these
 * matching semantics to the JSON produced by `payloadFor`. No code, only data.
 */

export type JsonOp = { path: string; value: unknown }
export type MockRule = {
  id: string
  name: string
  enabled: boolean
  match: { host: string; path: string; method?: string }
  kind: 'replace' | 'patch'
  // replace
  status?: number
  headers?: Record<string, string>
  body?: string
  // patch
  setHeaders?: Record<string, string>
  removeHeaders?: string[]
  json?: JsonOp[]
  delayMs?: number
}

/** «a.b[0].c», «items[*].price»: names, numeric or * indexes, dots between segments. */
export const JSON_PATH = /^[A-Za-z_$][\w$-]*(\[(\d+|\*)\])*(\.[A-Za-z_$][\w$-]*(\[(\d+|\*)\])*)*$/

const MAX_BODY = 1024 * 1024
const HOST_PATTERN = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/

/** Lower-cased host without port (IPv6 literals in brackets are kept whole). */
function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1) || h
  return h.replace(/:\d+$/, '')
}

/** Exact host or «*.example.com» (subdomains only); case and port are ignored. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = normalizeHost(host)
  const p = normalizeHost(pattern)
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1
  return h === p
}

/** Whole-path match where * is any run of characters; the query string is dropped first. */
export function pathMatches(path: string, pattern: string): boolean {
  const clean = (path.split('?')[0] ?? '').split('#')[0] ?? ''
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 's').test(clean)
}

export function ruleMatches(rule: MockRule, req: { method: string; host: string; path: string }): boolean {
  const { method } = rule.match
  if (method && method.toUpperCase() !== req.method.toUpperCase()) return false
  return hostMatches(req.host, rule.match.host) && pathMatches(req.path, rule.match.path)
}

const headersSchema = z.record(z.string().min(1), z.string())

export const mockRuleSchema: z.ZodType<Omit<MockRule, 'id' | 'enabled'>> = z
  .object({
    name: z.string().min(1, 'Укажите имя правила').max(80, 'Имя не длиннее 80 символов'),
    match: z.object({
      host: z
        .string()
        .regex(HOST_PATTERN, 'Хост — без схемы и пути: api.example.com или *.example.com'),
      path: z.string().startsWith('/', 'Путь начинается с /'),
      method: z
        .string()
        .regex(/^[A-Za-z]+$/, 'Метод — например GET или POST')
        .optional(),
    }),
    kind: z.enum(['replace', 'patch']),
    status: z.number().int().min(100, 'Статус от 100 до 599').max(599, 'Статус от 100 до 599').optional(),
    headers: headersSchema.optional(),
    body: z.string().max(MAX_BODY, 'Тело не больше 1 МБ').optional(),
    setHeaders: headersSchema.optional(),
    removeHeaders: z.array(z.string().min(1)).optional(),
    json: z
      .array(
        z.object({
          path: z.string().regex(JSON_PATH, 'Неверный путь в JSON, например user.items[0].price'),
          value: z.unknown(),
        }),
      )
      .optional(),
    delayMs: z.number().int().min(0, 'Задержка от 0 до 30000 мс').max(30000, 'Задержка от 0 до 30000 мс').optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.kind === 'replace') {
      if (rule.body === undefined) {
        ctx.addIssue({ code: 'custom', path: ['body'], message: 'Для подмены целиком нужно тело (можно пустое)' })
      }
      return
    }
    const hasChange =
      rule.status !== undefined ||
      rule.setHeaders !== undefined ||
      rule.removeHeaders !== undefined ||
      rule.json !== undefined ||
      rule.delayMs !== undefined
    if (!hasChange) {
      ctx.addIssue({
        code: 'custom',
        message: 'Для правки нужно хотя бы одно: status, setHeaders, removeHeaders, json или delayMs',
      })
    }
  })

/**
 * What the addon receives: enabled rules only, in the given order. The addon takes the first matching
 * rule of each kind, so callers pass `listMocks()` (oldest first, then by id) — equal sets give equal JSON.
 */
export function payloadFor(rules: MockRule[]): string {
  return JSON.stringify({ rules: rules.filter((r) => r.enabled) })
}
