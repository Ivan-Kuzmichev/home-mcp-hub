import { z } from 'zod'
import { maskJsonOpValue, maskUrl } from '../../redact'
import { formatSize, plural } from '../format'
import { defineConnector, field, secret, toolFor, ToolError } from '../types'
import { MitmClient } from './client'
import { ruleMatches, mockRuleSchema, type JsonOp, type MockRule } from './rules'
import { clockOf, filterFlows, hostOf, isHttp, hostSummary, mockLabel, parseMockComment, renderFlow, sizeOf } from './flows'

const configSchema = z.object({
  baseUrl: field(
    z
      .string()
      .trim()
      .url('Нужен адрес вида http://host:port')
      .transform((v) => v.replace(/\/+$/, ''))
      .default('http://mitmweb:8081'),
    {
      label: 'Адрес mitmweb',
      placeholder: 'http://mitmweb:8081',
      help: 'Внутренний адрес веб-интерфейса mitmweb',
      widget: 'url',
      mono: true,
      section: 'connection',
    },
  ),
  password: secret({ label: 'Пароль веб-интерфейса', help: 'MITM_WEB_PASSWORD. Пусто — без пароля', section: 'connection' }),
  allowMocks: field(z.boolean().default(false), {
    label: 'Разрешить моки',
    help: 'Подмена ответов сервисов. Выключено — только просмотр трафика',
    widget: 'switch',
    section: 'defaults',
  }),
  showTokens: field(z.boolean().default(false), {
    label: 'Показывать токены',
    help: 'Выключено — токены и пароли в заголовках и телах маскируются',
    widget: 'switch',
    section: 'defaults',
  }),
  textLimit: field(z.coerce.number().int().min(2000).max(200_000).default(24_000), {
    label: 'Лимит текста в ответе, символов',
    help: 'Сколько текста в одном ответе',
    widget: 'number',
    section: 'defaults',
  }),
  timeoutSec: field(z.coerce.number().int().min(5).max(120).default(15), {
    label: 'Таймаут запроса, с',
    help: 'На один вызов mitmweb',
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

const methodInput = z.string().regex(/^[A-Za-z]+$/).optional().describe('HTTP-метод, например GET; пусто — любой')
const headersInput = z.record(z.string(), z.string())
const ruleTarget = {
  id: z.string().min(1).optional().describe('id существующего правила — заменит его; пусто — новое'),
  name: z.string().describe('Короткое имя правила, например «Премиум»'),
  host: z.string().describe('Хост: api.example.com или *.example.com'),
  path: z.string().describe('Путь со звёздочкой, например /v1/profile или /v1/*; query не учитывается'),
  method: methodInput,
  delayMs: z.number().int().min(0).max(30000).optional().describe('Задержка ответа, мс'),
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
  if (r.kind === 'replace') parts.push(`ответ ${r.status ?? 200}, тело ${(r.body ?? '').length} симв.`)
  else if (r.status !== undefined) parts.push(`статус ${r.status}`)
  if (r.setHeaders) parts.push(`заголовки: ${Object.keys(r.setHeaders).join(', ')}`)
  if (r.removeHeaders) parts.push(`без заголовков: ${r.removeHeaders.join(', ')}`)
  if (r.delayMs) parts.push(`задержка ${r.delayMs} мс`)
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
  if (failure) return `Мок «${rule.name}» (${rule.id}) сохранён, но пока не работает: ${failure}`
  const hits = (await client(config).flows().catch(() => [])).filter(
    (f) => isHttp(f) && ruleMatches(rule, { method: f.request!.method, host: hostOf(f), path: f.request!.path }),
  ).length
  const state = rule.enabled ? 'включён' : 'сохранён, но выключен'
  return `Мок «${rule.name}» ${state}: ${targetOf(rule)} → ${describeChange(rule)}. Под шаблон уже попадало ${hits} ${plural(hits, ['запрос', 'запроса', 'запросов'])} из перехваченных. id: ${rule.id}`
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

const minutesInput = z.number().int().min(1).max(1440).optional().describe('За сколько последних минут, по умолчанию 15')

export const mitmproxy = defineConnector<Config>({
  id: 'mitmproxy',
  name: 'mitmproxy',
  description: 'Перехват трафика: куда ходят приложения и моки',
  docsUrl: 'https://docs.mitmproxy.org/',
  configSchema,

  hiddenTools: (c) => (c.allowMocks ? [] : [...MOCK_TOOLS]),

  instructions(_c, { tools }) {
    const base = 'mitmproxy: куда ходят приложения — mitm_hosts, детали — mitm_flow; токены в ответах скрыты.'
    return tools.includes('mitm_mock_replace')
      ? `${base} Моки — mitm_mock_replace (ответ целиком) и mitm_mock_patch (поля настоящего ответа); перед удалением всех — переспроси.`
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
          `в памяти ${flows.length} ${plural(flows.length, ['запрос', 'запроса', 'запросов'])}`,
          `аддон hub_mocks: ${'hub_mocks' in options ? 'подключён' : 'не подключён'}`,
          `ответ ${Date.now() - started} мс`,
        ],
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'mitm_status',
      title: 'Состояние mitmproxy',
      description: 'Версия mitmproxy, режимы, сколько запросов в памяти, подключён ли аддон моков и сколько правил активно.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const mc = client(config)
        const [state, flows, options] = await Promise.all([mc.state(), mc.flows(), mc.options()])
        const active = config.allowMocks ? `правил активно ${(await mocks()).filter((m) => m.enabled).length}` : 'моки выключены'
        return [
          `mitmproxy ${state.version}`,
          `режимы ${state.modes.join(', ') || '—'}`,
          `в памяти ${flows.length} ${plural(flows.length, ['запрос', 'запроса', 'запросов'])}`,
          `аддон hub_mocks ${'hub_mocks' in options ? 'подключён' : 'нет'}`,
          active,
        ].join(' · ')
      },
    }),

    tool({
      name: 'mitm_hosts',
      title: 'Куда ходят приложения',
      description: 'Сводка трафика по доменам за последние минуты: число запросов, объём, коды ответов. app — фильтр по приложению (из User-Agent, без регистра).',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ minutes: minutesInput, app: z.string().optional().describe('Имя приложения, например Bank') }),
      async run({ minutes = 15, app }, { config }) {
        const flows = await client(config).flows()
        const rows = hostSummary(flows, { sinceMs: Date.now() - minutes * 60_000, app })
        const total = rows.reduce((n, r) => n + r.count, 0)
        if (rows.length === 0) return `За ${minutes} мин запросов нет.`
        const out = [`За ${minutes} мин: ${rows.length} ${plural(rows.length, ['домен', 'домена', 'доменов'])}, ${total} ${plural(total, ['запрос', 'запроса', 'запросов'])}`]
        let size = out[0]!.length
        for (const [i, r] of rows.entries()) {
          const codes = Object.entries(r.codes).map(([k, v]) => `${k} ${v}`).join(' / ')
          const line = `• ${r.host} — ${r.count} запр. · ${formatSize(r.bytes)}${codes ? ` · ${codes}` : ''}`
          if (size + line.length > config.textLimit) {
            out.push(`…и ещё ${rows.length - i} ${plural(rows.length - i, ['домен', 'домена', 'доменов'])}`)
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
      title: 'Список запросов',
      description: 'Последние запросы: id, метод, адрес, код, время, размер. Фильтры: host и path (подстрока), app. Подробности одного — mitm_flow по id.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        host: z.string().optional().describe('Часть имени хоста'),
        path: z.string().optional().describe('Часть пути'),
        app: z.string().optional().describe('Имя приложения'),
        minutes: minutesInput,
        limit: z.number().int().min(1).max(200).optional().describe('Сколько запросов, по умолчанию 30'),
      }),
      async run({ host, path, app, minutes = 15, limit = 30 }, { config }) {
        const flows = await client(config).flows()
        const found = filterFlows(flows, { host, path, app, sinceMs: Date.now() - minutes * 60_000 })
          .sort((a, b) => b.timestamp_created - a.timestamp_created)
        if (found.length === 0) return `За ${minutes} мин подходящих запросов нет.`
        const names = new Map((await mocks()).map((m) => [m.id, m.name]))
        const shown = found.slice(0, limit)
        const lines = shown.map((f) => {
          const r = f.request!
          const url = `${hostOf(f)}${r.path}`
          const status = f.response ? String(f.response.status_code) : f.error ? 'ошибка' : '…'
          const mock = mockLabel(f.comment ?? '', names)
          return `• ${f.id.slice(0, 8)} · ${r.method} ${config.showTokens ? url : maskUrl(url)} · ${status} · ${clockOf(f)} · ${sizeOf(f)}${mock ? ` · ${mock}` : ''}`
        })
        if (found.length > shown.length) lines.push(`…показано ${shown.length} из ${found.length}`)
        return lines.join('\n')
      },
    }),

    tool({
      name: 'mitm_flow',
      title: 'Один запрос',
      description: 'Заголовки и тела запроса и ответа. Токены и пароли скрыты. id — полный или первые 8 символов из mitm_flows. Длинное — частями через offset.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: z.string().min(4).describe('id запроса или его первые 8 символов'),
        offset: z.number().int().min(0).optional().describe('С какого символа продолжить'),
      }),
      async run({ id, offset = 0 }, { config }) {
        const mc = client(config)
        const matches = (await mc.flows()).filter((f) => f.id === id || f.id.startsWith(id))
        if (matches.length === 0) throw new ToolError('Запроса уже нет в mitmproxy — он хранит только последние запросы')
        if (matches.length > 1) throw new ToolError(`Под «${id}» подходит несколько запросов — укажи больше символов id`)
        const f = matches[0]!
        if (!isHttp(f)) return `Это не HTTP-запрос (${f.type}) — детали показываются только для HTTP.`
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
      title: 'Подменить ответ целиком',
      description:
        'Мок: на подходящие запросы (всех устройств) mitmproxy сам отвечает заданным status, headers и body, настоящий сервер не вызывается. ' +
        'Без Content-Type в headers: тело-JSON получит application/json, иначе text/plain. id существующего правила — заменит его.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        ...ruleTarget,
        status: z.number().int().min(100).max(599).optional().describe('Код ответа, по умолчанию 200'),
        headers: headersInput.optional().describe('Заголовки ответа'),
        body: z.string().describe('Тело ответа (можно пустое)'),
      }),
      async run({ id, name, host, path, method, status = 200, headers, body, delayMs }, { config }) {
        const h = headers ?? {}
        if (!hasContentType(h)) h['Content-Type'] = isJson(body) ? 'application/json' : 'text/plain; charset=utf-8'
        return applyRule(config, { id, name, match: { host, path, ...(method ? { method } : {}) }, kind: 'replace', status, headers: h, body, delayMs })
      },
    }),

    tool({
      name: 'mitm_mock_patch',
      title: 'Поправить настоящий ответ',
      description:
        'Мок: запрос уходит на настоящий сервер, а в ответе правятся поля. json — список {path, value}, путь вида user.items[0].price или items[*].price; ' +
        'setHeaders / removeHeaders — заголовки; status — другой код; delayMs — задержка. Нужно хотя бы одно изменение. id существующего правила — заменит его.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: z.object({
        ...ruleTarget,
        status: z.number().int().min(100).max(599).optional().describe('Подставить другой код ответа'),
        setHeaders: headersInput.optional().describe('Заголовки, которые выставить'),
        removeHeaders: z.array(z.string()).optional().describe('Заголовки, которые убрать'),
        json: z.array(z.object({ path: z.string(), value: z.unknown() })).optional().describe('Правки JSON-тела: путь и новое значение'),
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
      title: 'Список моков',
      description: 'Все правила моков: id, имя, включено ли, шаблон и сколько раз сработало среди перехваченных запросов.',
      // Read-only for the user: the sync before listing only reconciles edits already made in mitmweb.
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const m = await store()
        // Picks up changes made with the mitmweb commands right away.
        const failure = await pushMocks(m)
        const note = failure ? `\nНе синхронизировано с прокси: ${failure}` : ''
        const rules = m.listMocks()
        if (rules.length === 0) return `Моков нет.${note}`
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
          return `сработал ${n} ${plural(n, ['раз', 'раза', 'раз'])}${skipped ? `, из них json пропущен ${skipped}` : ''}`
        }
        return (
          rules
            .map((r) => `• ${r.id} «${r.name}» — ${r.enabled ? 'вкл' : 'выкл'} · ${r.kind} ${targetOf(r)} · ${fired(r.id)}`)
            .join('\n') + note
        )
      },
    }),

    tool({
      name: 'mitm_mock_toggle',
      title: 'Включить или выключить мок',
      description: 'Включить или выключить правило по id, не удаляя его.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ id: z.string().min(1), enabled: z.boolean() }),
      async run({ id, enabled }) {
        const m = await store()
        const { value: rule, failure } = await m.mutateMocks(() => m.setMockEnabled(id, enabled))
        const state = enabled ? 'включён' : 'выключен'
        return failure ? `Мок «${rule.name}» ${state}, но пока не применён: ${failure}` : `Мок «${rule.name}» ${state}.`
      },
    }),

    tool({
      name: 'mitm_mock_delete',
      title: 'Удалить мок',
      description: 'Удалить правило по id или все сразу (all: true). Все сразу — необратимо: сначала переспроси пользователя и передай confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: z.string().min(1).optional().describe('id правила'),
        all: z.boolean().optional().describe('true — удалить все правила'),
        confirm: z.boolean().optional().describe('true — пользователь подтвердил удаление всех'),
      }),
      async run({ id, all, confirm }) {
        const m = await store()
        if (all) {
          const n = m.listMocks().length
          if (confirm !== true) return `Не удалено. Переспроси пользователя и повтори с confirm: true.\nБудет удалено правил: ${n}`
          const { value: deleted, failure } = await m.mutateMocks(() => m.deleteAllMocks())
          return `Удалено правил: ${deleted}.${failure ? ` Не применено в прокси: ${failure}` : ''}`
        }
        if (!id) throw new ToolError('Укажи id правила или all: true')
        const { value: rule, failure } = await m.mutateMocks(() => {
          const found = m.listMocks().find((r) => r.id === id)
          if (!found) throw new ToolError(`Правила ${id} нет — посмотри mitm_mocks`)
          m.deleteMock(id)
          return found
        })
        return `Мок «${rule.name}» удалён.${failure ? ` Не применено в прокси: ${failure}` : ''}`
      },
    }),

    tool({
      name: 'mitm_clear',
      title: 'Очистить перехваченное',
      description: 'Стереть список перехваченных запросов в памяти mitmproxy. Правила моков остаются.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        await client(config).clear()
        return 'Список перехваченных запросов очищен.'
      },
    }),
  ],
})
