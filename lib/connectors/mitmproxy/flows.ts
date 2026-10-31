import { maskBody, maskHeaders, maskUrl } from '../../redact'
import { formatSize } from '../format'
import type { MitmFlow } from './client'

export type HostRow = { host: string; count: number; bytes: number; codes: Record<string, number> }

const BINARY_TYPE = /^(image|video|audio|font)\/|^application\/(octet-stream|protobuf|x-protobuf|zip|gzip|pdf)/i

function header(headers: [string, string][] | undefined, name: string): string | undefined {
  return headers?.find(([k]) => k.toLowerCase() === name)?.[1]
}

/** Client app from User-Agent: `AppName/1.2 CFNetwork…` gives `AppName`; no UA gives `?`. */
export function appOf(f: MitmFlow): string {
  const ua = header(f.request?.headers, 'user-agent')?.trim()
  if (!ua) return '?'
  const token = ua.split(/\s+/)[0] ?? ''
  const name = token.split('/')[0] ?? ''
  return name || '?'
}

function codeClass(f: MitmFlow): string | null {
  if (f.error) return 'ошибка'
  const s = f.response?.status_code
  if (!s) return null
  return `${Math.floor(s / 100)}xx`
}

function flowBytes(f: MitmFlow): number {
  return (f.request?.contentLength ?? 0) + (f.response?.contentLength ?? 0)
}

/** Host name as the client asked for it (Host / :authority), falling back to the connection host. */
export function hostOf(f: MitmFlow): string {
  return f.request?.pretty_host || f.request?.host || ''
}

export type FlowFilter = { host?: string; path?: string; app?: string; sinceMs: number }

/** mitmweb also returns dns/tcp/udp flows whose request has no host or path. */
export function isHttp(f: MitmFlow): boolean {
  return f.type === 'http' && typeof f.request?.host === 'string'
}

export function filterFlows(flows: MitmFlow[], q: FlowFilter): MitmFlow[] {
  const host = q.host?.toLowerCase()
  const path = q.path?.toLowerCase()
  const app = q.app?.toLowerCase()
  return flows.filter((f) => {
    if (!f.request || !isHttp(f) || f.timestamp_created * 1000 < q.sinceMs) return false
    if (host && !hostOf(f).toLowerCase().includes(host)) return false
    if (path && !f.request.path.toLowerCase().includes(path)) return false
    if (app && appOf(f).toLowerCase() !== app) return false
    return true
  })
}

export function hostSummary(flows: MitmFlow[], q: { sinceMs: number; app?: string }): HostRow[] {
  const rows = new Map<string, HostRow>()
  for (const f of filterFlows(flows, q)) {
    const host = hostOf(f)
    const row = rows.get(host) ?? { host, count: 0, bytes: 0, codes: {} }
    row.count++
    row.bytes += flowBytes(f)
    const code = codeClass(f)
    if (code) row.codes[code] = (row.codes[code] ?? 0) + 1
    rows.set(host, row)
  }
  return [...rows.values()].sort((a, b) => b.count - a.count)
}

export function clockOf(f: MitmFlow): string {
  return new Date(f.timestamp_created * 1000).toLocaleTimeString('ru-RU', { hour12: false })
}

const MOCK_COMMENT = /^mock:(\S+)( \(json пропущен\))?/

/** Rule id from the addon's `mock:<id>` or `mock:<id> (json пропущен)` comment; skipped tells the json ops were not applied. */
export function parseMockComment(comment: string): { id: string; skipped: boolean } | null {
  const m = MOCK_COMMENT.exec(comment)
  return m ? { id: m[1]!, skipped: m[2] !== undefined } : null
}

/** «мок «Премиум»» or «мок «Премиум» (json пропущен)»; the id when the rule is gone. */
export function mockLabel(comment: string, names: Map<string, string>): string | null {
  const m = parseMockComment(comment)
  return m ? `мок «${names.get(m.id) ?? m.id}»${m.skipped ? ' (json пропущен)' : ''}` : null
}

export type FlowBodies = { request?: Buffer | null; response?: Buffer | null }
export type RenderOpts = { masked: boolean; limit: number; offset: number; mock?: string | null }

function bodyText(
  part: 'request' | 'response',
  f: MitmFlow,
  buf: Buffer | null | undefined,
  masked: boolean,
): string {
  const m = part === 'request' ? f.request : f.response
  const headers = m?.headers
  // In mitmweb JSON a null contentLength means the raw content was not stored (streamed past the limit).
  if (m && m.contentLength === null) return 'тело не сохранено (больше 1 МБ, стрим)'
  if (!buf || buf.length === 0) return '(пусто)'
  const type = (header(headers, 'content-type') ?? '').split(';')[0]!.trim()
  if (BINARY_TYPE.test(type)) return `бинарное, ${buf.length} байт`
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return `бинарное, ${buf.length} байт`
  }
  return masked ? maskBody(text, type) : text
}

function headerLines(headers: [string, string][] | undefined, masked: boolean): string[] {
  const list = headers ?? []
  return (masked ? maskHeaders(list) : list).map(([k, v]) => `${k}: ${v}`)
}

export function renderFlow(f: MitmFlow, bodies: FlowBodies, o: RenderOpts): string {
  const req = f.request
  const lines: string[] = []
  const url = req ? `${req.scheme}://${hostOf(f)}${req.path}` : '?'
  lines.push(`${req?.method ?? '?'} ${o.masked ? maskUrl(url) : url}`)
  const status = f.response ? String(f.response.status_code) : f.error ? 'ошибка' : 'нет ответа'
  lines.push(`id ${f.id} · ${status} · ${clockOf(f)} · приложение ${appOf(f)}`)
  if (o.mock) lines.push(o.mock)
  if (f.error) lines.push(`Ошибка: ${f.error.msg}`)
  lines.push('', '— Запрос —', ...headerLines(req?.headers, o.masked), '', bodyText('request', f, bodies.request, o.masked))
  if (f.response) {
    lines.push('', '— Ответ —', ...headerLines(f.response.headers, o.masked), '', bodyText('response', f, bodies.response, o.masked))
  }
  const full = lines.join('\n')
  const page = full.slice(o.offset, o.offset + o.limit)
  const next = o.offset + o.limit
  return next < full.length ? `${page}\n… (offset для продолжения: ${next})` : page
}

export function sizeOf(f: MitmFlow): string {
  return formatSize(flowBytes(f))
}
