import { z } from 'zod'
import { maskUrl } from '../../redact'
import { formatSize, plural } from '../format'
import { defineConnector, field, secret, toolFor, ToolError } from '../types'
import { MitmClient } from './client'
import { clockOf, filterFlows, hostSummary, mockLabel, renderFlow, sizeOf } from './flows'

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
async function mocks() {
  return (await import('./mocks')).listMocks()
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
        const active = (await mocks()).filter((m) => m.enabled).length
        return [
          `mitmproxy ${state.version}`,
          `режимы ${state.modes.join(', ') || '—'}`,
          `в памяти ${flows.length} ${plural(flows.length, ['запрос', 'запроса', 'запросов'])}`,
          `аддон hub_mocks ${'hub_mocks' in options ? 'подключён' : 'нет'}`,
          `правил активно ${active}`,
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
          const url = `${r.host}${r.path}`
          const status = f.response ? String(f.response.status_code) : f.error ? 'ошибка' : '…'
          const mock = mockLabel(f.comment ?? '', names)
          return `• ${f.id.slice(0, 8)} · ${r.method} ${config.showTokens ? url : maskUrl(url)} · ${status} · ${clockOf(f)} · ${sizeOf(f)}${mock ? ` · мок «${mock}»` : ''}`
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
        const fetchBody = (part: 'request' | 'response') => {
          const m = part === 'request' ? f.request : f.response
          return m && (m.contentLength ?? 0) > 0 ? mc.content(f.id, part) : Promise.resolve(null)
        }
        const [request, response] = await Promise.all([fetchBody('request'), fetchBody('response')])
        const names = new Map((await mocks()).map((m) => [m.id, m.name]))
        return renderFlow(f, { request, response }, { masked: !config.showTokens, limit: config.textLimit, offset, mock: mockLabel(f.comment ?? '', names) })
      },
    }),
  ],
})
