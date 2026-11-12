import { z } from 'zod'
import { maskJsonOpValue, maskUrl } from '../../redact'
import { formatSize, plural } from '../format'
import { defineConnector, field, secret, toolFor, ToolError } from '../types'
import { MitmClient } from './client'
import { ruleMatches, mockRuleSchema, type JsonOp, type MockRule } from './rules'
import { clockOf, filterFlows, hostOf, isHttp, hostSummary, mockLabel, parseMockComment, renderFlow, sizeOf } from './flows'
import { t } from '../../i18n'

const configSchema = z.object({
  baseUrl: field(
    z
      .string()
      .trim()
      .url({ error: () => t`Needs an address like http://host:port` })
      .transform((v) => v.replace(/\/+$/, ''))
      .default('http://mitmweb:8081'),
    {
      label: 'mitmweb address',
      placeholder: 'http://mitmweb:8081',
      help: 'The internal address of the mitmweb web interface',
      widget: 'url',
      mono: true,
      section: 'connection',
    },
  ),
  password: secret({ label: 'Web interface password', help: 'MITM_WEB_PASSWORD. Empty — no password', section: 'connection' }),
  allowMocks: field(z.boolean().default(false), {
    label: 'Allow mocks',
    help: 'Replace service responses. Off — only viewing traffic',
    widget: 'switch',
    section: 'defaults',
  }),
  showTokens: field(z.boolean().default(false), {
    label: 'Show tokens',
    help: 'Off — tokens and passwords in headers and bodies are masked',
    widget: 'switch',
    section: 'defaults',
  }),
  textLimit: field(z.coerce.number().int().min(2000).max(200_000).default(24_000), {
    label: 'Text limit per reply, characters',
    help: 'How much text goes in one reply',
    widget: 'number',
    section: 'defaults',
  }),
  timeoutSec: field(z.coerce.number().int().min(5).max(120).default(15), {
    label: 'Request timeout, s',
    help: 'Per mitmweb call',
    widget: 'number',
    section: 'defaults',
  }),
})

export type Config = z.infer<typeof configSchema>

const tool = toolFor<Config>()
const client = (c: Config) => new MitmClient({ baseUrl: c.baseUrl, password: c.password, timeoutSec: c.timeoutSec })

export const MOCK_TOOLS = ['mitm_mock_replace', 'mitm_mock_patch', 'mitm_mocks', 'mitm_mock_toggle', 'mitm_mock_delete', 'mitm_clear']

// Loaded lazily: mocks.ts imports the registry, which imports this file.
const store = () => import('./mocks')
async function mocks() {
  return (await store()).listMocks()
}

const methodInput = z.string().regex(/^[A-Za-z]+$/).optional().describe('HTTP method, for example GET; empty — any')
const headersInput = z.record(z.string(), z.string())
const ruleTarget = {
  id: z.string().min(1).optional().describe('id of an existing rule — replaces it; empty — a new one'),
  name: z.string().describe('A short rule name, for example “Premium”'),
  host: z.string().describe('Host: api.example.com or *.example.com'),
  path: z.string().describe('A path with a star, for example /v1/profile or /v1/*; the query is ignored'),
  method: methodInput,
  delayMs: z.number().int().min(0).max(30000).optional().describe('Response delay, ms'),
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function describeChange(r: Omit<MockRule, 'id' | 'enabled'>): string {
  const parts: string[] = []
  for (const op of r.json ?? []) parts.push(`${op.path} = ${JSON.stringify(maskJsonOpValue(op.path, op.value))}`.slice(0, 80))
  if (r.kind === 'replace') parts.push(t`response ${r.status ?? 200}, body ${(r.body ?? '').length} chars`)
  else if (r.status !== undefined) parts.push(t`status ${r.status}`)
  if (r.setHeaders) parts.push(t`headers: ${Object.keys(r.setHeaders).join(', ')}`)
  if (r.removeHeaders) parts.push(t`without headers: ${r.removeHeaders.join(', ')}`)
  if (r.delayMs) parts.push(t`delay ${r.delayMs} ms`)
  return parts.join(', ')
}

const targetOf = (r: { match: MockRule['match'] }) => `${r.match.method ? `${r.match.method.toUpperCase()} ` : ''}${r.match.host}${r.match.path}`

/** Validate, store, push to the proxy. A failed push keeps the rule and says what to fix. */
async function applyRule(config: Config, input: Omit<MockRule, 'id' | 'enabled'> & { id?: string }): Promise<string> {
  const { id, ...body } = input
  const parsed = mockRuleSchema.safeParse(body)
  if (!parsed.success) throw new ToolError(parsed.error.issues.map((i) => i.message).join('; '))
  const m = await store()
  const { value: rule, failure } = await m.mutateMocks(() => m.saveMock({ ...parsed.data, ...(id ? { id } : {}) }))
  if (failure) return t`Mock “${rule.name}” (${rule.id}) is saved but does not work yet: ${failure}`
  const hits = (await client(config).flows().catch(() => [])).filter(
    (f) => isHttp(f) && ruleMatches(rule, { method: f.request!.method, host: hostOf(f), path: f.request!.path }),
  ).length
  const state = rule.enabled ? t`enabled` : t`saved, but off`
  return t`Mock “${rule.name}” ${state}: ${targetOf(rule)} → ${describeChange(rule)}. ${hits} ${plural(hits, ['request', 'requests'])} of the captured ones already matched the pattern. id: ${rule.id}`
}

async function pushMocks(m: Awaited<ReturnType<typeof store>>): Promise<string | null> {
  try {
    await m.syncMocks({ strict: true })
    return null
  } catch (e) {
    if (e instanceof ToolError) return e.message
    throw e
  }
}

const minutesInput = z.number().int().min(1).max(1440).optional().describe('For how many recent minutes, 15 by default')

export const mitmproxy = defineConnector<Config>({
  id: 'mitmproxy',
  name: 'mitmproxy',
  description: 'Traffic capture: where apps go, and mocks',
  docsUrl: 'https://docs.mitmproxy.org/',
  configSchema,

  hiddenTools: (c) => (c.allowMocks ? [] : [...MOCK_TOOLS]),

  instructions(_c, { tools }) {
    const base = t`mitmproxy: where apps go — mitm_hosts, details — mitm_flow; tokens in replies are hidden.`
    return tools.includes('mitm_mock_replace')
      ? t`${base} Mocks — mitm_mock_replace (a whole response) and mitm_mock_patch (fields of the real response); ask before deleting all.`
      : base
  },

  async test(c) {
    const started = Date.now()
    try {
      const mc = client(c)
      const [state, flows, options] = await Promise.all([mc.state(), mc.flows(), mc.options()])
      return {
        ok: true,
        version: state.version,
        summary: `mitmproxy ${state.version}`,
        details: [
          t`${flows.length} ${plural(flows.length, ['request', 'requests'])} in memory`,
          t`hub_mocks addon: ${'hub_mocks' in options ? t`loaded` : t`not loaded`}`,
          t`response ${Date.now() - started} ms`,
        ],
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'mitm_status',
      title: 'mitmproxy status',
      description: 'The mitmproxy version, modes, how many requests are in memory, whether the mock addon is loaded and how many rules are active.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const mc = client(config)
        const [state, flows, options] = await Promise.all([mc.state(), mc.flows(), mc.options()])
        const active = config.allowMocks ? t`${(await mocks()).filter((m) => m.enabled).length} rules active` : t`mocks off`
        return [
          `mitmproxy ${state.version}`,
          t`modes ${state.modes.join(', ') || '—'}`,
          t`${flows.length} ${plural(flows.length, ['request', 'requests'])} in memory`,
          t`hub_mocks addon ${'hub_mocks' in options ? t`loaded` : t`none`}`,
          active,
        ].join(' · ')
      },
    }),

    tool({
      name: 'mitm_hosts',
      title: 'Where apps go',
      description: 'A traffic summary by domain over the last minutes: request count, volume, response codes. app — filter by app (from the User-Agent, case-insensitive).',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ minutes: minutesInput, app: z.string().optional().describe('App name, for example Bank') }),
      async run({ minutes = 15, app }, { config }) {
        const flows = await client(config).flows()
        const rows = hostSummary(flows, { sinceMs: Date.now() - minutes * 60_000, app })
        const total = rows.reduce((n, r) => n + r.count, 0)
        if (rows.length === 0) return t`No requests in ${minutes} min.`
        const out = [t`In ${minutes} min: ${rows.length} ${plural(rows.length, ['domain', 'domains'])}, ${total} ${plural(total, ['request', 'requests'])}`]
        let size = out[0]!.length
        for (const [i, r] of rows.entries()) {
          const codes = Object.entries(r.codes).map(([k, v]) => `${k} ${v}`).join(' / ')
          const line = t`• ${r.host} — ${r.count} req. · ${formatSize(r.bytes)}${codes ? ` · ${codes}` : ''}`
          if (size + line.length > config.textLimit) {
            out.push(t`…and ${rows.length - i} more ${plural(rows.length - i, ['domain', 'domains'])}`)
            break
          }
          out.push(line)
          size += line.length + 1
        }
        return out.join('\n')
      },
    }),

    tool({
      name: 'mitm_flows',
      title: 'Request list',
      description: 'The latest requests: id, method, address, code, time, size. Filters: host and path (substring), app. Details of one — mitm_flow by id.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        host: z.string().optional().describe('Part of the host name'),
        path: z.string().optional().describe('Part of the path'),
        app: z.string().optional().describe('App name'),
        minutes: minutesInput,
        limit: z.number().int().min(1).max(200).optional().describe('How many requests, 30 by default'),
      }),
      async run({ host, path, app, minutes = 15, limit = 30 }, { config }) {
        const flows = await client(config).flows()
        const found = filterFlows(flows, { host, path, app, sinceMs: Date.now() - minutes * 60_000 })
          .sort((a, b) => b.timestamp_created - a.timestamp_created)
        if (found.length === 0) return t`No matching requests in ${minutes} min.`
        const names = new Map((await mocks()).map((m) => [m.id, m.name]))
        const shown = found.slice(0, limit)
        const lines = shown.map((f) => {
          const r = f.request!
          const url = `${hostOf(f)}${r.path}`
          const status = f.response ? String(f.response.status_code) : f.error ? t`error` : '…'
          const mock = mockLabel(f.comment ?? '', names)
          return `• ${f.id.slice(0, 8)} · ${r.method} ${config.showTokens ? url : maskUrl(url)} · ${status} · ${clockOf(f)} · ${sizeOf(f)}${mock ? ` · ${mock}` : ''}`
        })
        if (found.length > shown.length) lines.push(t`…showing ${shown.length} of ${found.length}`)
        return lines.join('\n')
      },
    }),

    tool({
      name: 'mitm_flow',
      title: 'One request',
      description: 'Headers and bodies of the request and response. Tokens and passwords are hidden. id — the full one or the first 8 characters from mitm_flows. Long ones in parts via offset.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: z.string().min(4).describe('request id or its first 8 characters'),
        offset: z.number().int().min(0).optional().describe('Character to continue from'),
      }),
      async run({ id, offset = 0 }, { config }) {
        const mc = client(config)
        const matches = (await mc.flows()).filter((f) => f.id === id || f.id.startsWith(id))
        if (matches.length === 0) throw new ToolError(t`The request is no longer in mitmproxy — it keeps only the latest requests`)
        if (matches.length > 1) throw new ToolError(t`Several requests match “${id}” — give more characters of the id`)
        const f = matches[0]!
        if (!isHttp(f)) return t`This is not an HTTP request (${f.type}) — details are shown only for HTTP.`
        const fetchBody = (part: 'request' | 'response') => {
          const m = part === 'request' ? f.request : f.response
          return m && (m.contentLength ?? 0) > 0 ? mc.content(f.id, part) : Promise.resolve(null)
        }
        const [request, response] = await Promise.all([fetchBody('request'), fetchBody('response')])
        const names = new Map((await mocks()).map((m) => [m.id, m.name]))
        return renderFlow(f, { request, response }, { masked: !config.showTokens, limit: config.textLimit, offset, mock: mockLabel(f.comment ?? '', names) })
      },
    }),

    tool({
      name: 'mitm_mock_replace',
      title: 'Replace the whole response',
      description:
        'Mock: matching requests (from every device) get the given status, headers and body from mitmproxy itself, the real server is not called. Without Content-Type in headers a JSON body gets application/json, otherwise text/plain. The id of an existing rule replaces it.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        ...ruleTarget,
        status: z.number().int().min(100).max(599).optional().describe('Response code, 200 by default'),
        headers: headersInput.optional().describe('Response headers'),
        body: z.string().describe('Response body (may be empty)'),
      }),
      async run({ id, name, host, path, method, status = 200, headers, body, delayMs }, { config }) {
        const h = headers ?? {}
        if (!hasContentType(h)) h['Content-Type'] = isJson(body) ? 'application/json' : 'text/plain; charset=utf-8'
        return applyRule(config, { id, name, match: { host, path, ...(method ? { method } : {}) }, kind: 'replace', status, headers: h, body, delayMs })
      },
    }),

    tool({
      name: 'mitm_mock_patch',
      title: 'Patch the real response',
      description:
        'Mock: the request goes to the real server and fields are changed in the response. json — a list of {path, value}, a path like user.items[0].price or items[*].price; setHeaders / removeHeaders — headers; status — another code; delayMs — a delay. At least one change is required. The id of an existing rule replaces it.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: z.object({
        ...ruleTarget,
        status: z.number().int().min(100).max(599).optional().describe('Use another response code'),
        setHeaders: headersInput.optional().describe('Headers to set'),
        removeHeaders: z.array(z.string()).optional().describe('Headers to remove'),
        json: z.array(z.object({ path: z.string(), value: z.unknown() })).optional().describe('JSON body edits: a path and a new value'),
      }),
      async run({ id, name, host, path, method, status, setHeaders, removeHeaders, json, delayMs }, { config }) {
        return applyRule(config, {
          id,
          name,
          match: { host, path, ...(method ? { method } : {}) },
          kind: 'patch',
          status,
          setHeaders,
          removeHeaders,
          json: json as JsonOp[] | undefined,
          delayMs,
        })
      },
    }),

    tool({
      name: 'mitm_mocks',
      title: 'Mock list',
      description: 'All mock rules: id, name, whether it is on, the pattern and how many times it hit among the captured requests.',
      // Read-only for the user: the sync before listing only reconciles edits already made in mitmweb.
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const m = await store()
        // Picks up changes made with the mitmweb commands right away.
        const failure = await pushMocks(m)
        const note = failure ? t`
Not synced with the proxy: ${failure}` : ''
        const rules = m.listMocks()
        if (rules.length === 0) return t`No mocks.${note}`
        const hits = new Map<string, { n: number; skipped: number }>()
        for (const f of await client(config).flows().catch(() => [])) {
          const m = parseMockComment(f.comment ?? '')
          if (!m || !isHttp(f)) continue
          const h = hits.get(m.id) ?? { n: 0, skipped: 0 }
          h.n++
          if (m.skipped) h.skipped++
          hits.set(m.id, h)
        }
        const fired = (id: string) => {
          const { n, skipped } = hits.get(id) ?? { n: 0, skipped: 0 }
          return t`hit ${n} ${plural(n, ['time', 'times'])}${skipped ? t`, json skipped in ${skipped} of them` : ''}`
        }
        return (
          rules
            .map((r) => `• ${r.id} «${r.name}» — ${r.enabled ? t`on` : t`off`} · ${r.kind} ${targetOf(r)} · ${fired(r.id)}`)
            .join('\n') + note
        )
      },
    }),

    tool({
      name: 'mitm_mock_toggle',
      title: 'Turn a mock on or off',
      description: 'Turn a rule on or off by id without deleting it.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ id: z.string().min(1), enabled: z.boolean() }),
      async run({ id, enabled }) {
        const m = await store()
        const { value: rule, failure } = await m.mutateMocks(() => m.setMockEnabled(id, enabled))
        const state = enabled ? t`enabled` : t`disabled`
        return failure ? t`Mock “${rule.name}” is ${state}, but not applied yet: ${failure}` : t`Mock “${rule.name}” is ${state}.`
      },
    }),

    tool({
      name: 'mitm_mock_delete',
      title: 'Delete mock',
      description: 'Delete a rule by id or all at once (all: true). All at once cannot be undone: ask the user first and pass confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: z.string().min(1).optional().describe('rule id'),
        all: z.boolean().optional().describe('true — delete all rules'),
        confirm: z.boolean().optional().describe('true — the user confirmed deleting all'),
      }),
      async run({ id, all, confirm }) {
        const m = await store()
        if (all) {
          const n = m.listMocks().length
          if (confirm !== true) return t`Not deleted. Ask the user and repeat with confirm: true.
Rules to be deleted: ${n}`
          const { value: deleted, failure } = await m.mutateMocks(() => m.deleteAllMocks())
          return t`Rules deleted: ${deleted}.${failure ? t` Not applied in the proxy: ${failure}` : ''}`
        }
        if (!id) throw new ToolError(t`Give a rule id or all: true`)
        const { value: rule, failure } = await m.mutateMocks(() => {
          const found = m.listMocks().find((r) => r.id === id)
          if (!found) throw new ToolError(t`No rule ${id} — check mitm_mocks`)
          m.deleteMock(id)
          return found
        })
        return t`Mock “${rule.name}” deleted.${failure ? t` Not applied in the proxy: ${failure}` : ''}`
      },
    }),

    tool({
      name: 'mitm_clear',
      title: 'Clear captured traffic',
      description: 'Erase the list of captured requests in the mitmproxy memory. Mock rules stay.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        await client(config).clear()
        return t`The captured request list is cleared.`
      },
    }),
  ],
})
