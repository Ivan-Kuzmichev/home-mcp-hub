import { z } from 'zod'
import { magnetInfoHash, torrentInfoHash } from '../bencode'
import { formatEta, formatSize, formatSpeed, plural, truncate } from '../format'
import { baseUrl, defineConnector, field, secret, toolFor, ToolError } from '../types'
import { QbClient, type QbConfig, type QbTorrent } from './client'

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Адрес в локальной сети', placeholder: 'http://qbittorrent:8080' }),
    authMode: field(z.enum(['none', 'apikey', 'password']).default('none'), {
      label: 'Способ входа',
      widget: 'segmented',
      section: 'connection',
      options: [
        {
          value: 'none',
          label: 'Без авторизации',
          short: 'Без входа',
          help: 'Хаб ходит в qBittorrent без логина. В qBittorrent: Настройки → Web UI → «Пропускать аутентификацию для клиентов в подсетях» → добавить подсеть, из которой приходит хаб.',
          showHubNetwork: true,
        },
        { value: 'apikey', label: 'API-ключ (5.2+)', short: 'API-ключ', help: 'Ключ из Настройки → Web UI → API-ключ. Передаётся как Authorization: Bearer.' },
        { value: 'password', label: 'Логин и пароль', short: 'Логин', help: 'Логин и пароль от Web UI qBittorrent.' },
      ],
    }),
    apiKey: secret({ label: 'API-ключ', section: 'connection', showWhen: { field: 'authMode', equals: ['apikey'] } }),
    username: field(z.string().trim().optional(), { label: 'Логин', section: 'connection', showWhen: { field: 'authMode', equals: ['password'] } }),
    password: secret({ label: 'Пароль', section: 'connection', showWhen: { field: 'authMode', equals: ['password'] } }),
    defaultCategory: field(z.string().trim().optional(), { label: 'Категория по умолчанию', placeholder: 'claude', section: 'defaults' }),
    savePath: field(z.string().trim().optional(), { label: 'Папка сохранения', placeholder: '/downloads/claude', mono: true, section: 'defaults' }),
    addStopped: field(z.boolean().default(false), {
      label: 'Добавлять торренты остановленными',
      help: 'Claude сам вызовет torrent_start',
      widget: 'switch',
      section: 'defaults',
    }),
  })
  .superRefine((c, ctx) => {
    if (c.authMode === 'apikey' && !c.apiKey) ctx.addIssue({ code: 'custom', path: ['apiKey'], message: 'Нужен API-ключ' })
    if (c.authMode === 'password') {
      if (!c.username) ctx.addIssue({ code: 'custom', path: ['username'], message: 'Нужен логин' })
      if (!c.password) ctx.addIssue({ code: 'custom', path: ['password'], message: 'Нужен пароль' })
    }
  })

type Config = z.output<typeof configSchema>

const client = (c: Config) => new QbClient(c satisfies QbConfig)
const tool = toolFor<Config>()

const STATE_LABELS: Record<string, string> = {
  downloading: 'качается',
  forcedDL: 'качается',
  metaDL: 'получает метаданные',
  forcedMetaDL: 'получает метаданные',
  stalledDL: 'ждёт пиров',
  uploading: 'раздаётся',
  forcedUP: 'раздаётся',
  stalledUP: 'готов, раздаётся',
  stoppedDL: 'остановлен',
  stoppedUP: 'готов',
  queuedDL: 'в очереди',
  queuedUP: 'в очереди на раздачу',
  checkingDL: 'проверка',
  checkingUP: 'проверка',
  checkingResumeData: 'проверка',
  moving: 'перемещается',
  error: 'ошибка',
  missingFiles: 'нет файлов',
}

export const shortHash = (hash: string) => hash.slice(0, 8)

export function formatTorrentLine(t: QbTorrent): string {
  const pct = Math.floor(t.progress * 100)
  const parts = [`${pct}%`]
  if (t.progress < 1 && t.dlspeed > 0) parts.push(`↓ ${formatSpeed(t.dlspeed)}`, `осталось ${formatEta(t.eta)}`)
  if (t.upspeed > 0) parts.push(`↑ ${formatSpeed(t.upspeed)}`)
  parts.push(`сиды ${t.num_seeds}/${t.num_complete}`, formatSize(t.size), STATE_LABELS[t.state] ?? t.state)
  return `• ${truncate(t.name, 70)} — ${parts.join(' · ')} · hash ${shortHash(t.hash)}`
}

/**
 * Claude passes back what it saw: a short hash, a full hash or part of the name.
 * Resolve to full hashes or explain the ambiguity.
 */
export function matchTorrents(all: QbTorrent[], refs: string[]): QbTorrent[] {
  return refs.map((ref) => {
    const r = ref.trim().toLowerCase()
    if (!r) throw new ToolError('Пустой hash')
    const byHash = all.filter((t) => t.hash.toLowerCase().startsWith(r))
    if (byHash.length === 1 && r.length >= 4) return byHash[0]!
    const byName = byHash.length ? [] : all.filter((t) => t.name.toLowerCase().includes(r))
    const matches = byHash.length ? byHash : byName
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) throw new ToolError(`Торрент «${ref}» не найден — посмотри torrents_status`)
    throw new ToolError(
      `«${ref}» подходит к нескольким торрентам:\n${matches
        .slice(0, 5)
        .map((t) => `• ${truncate(t.name, 60)} · hash ${shortHash(t.hash)}`)
        .join('\n')}`,
    )
  })
}

const FILTERS = {
  active: 'active',
  downloading: 'downloading',
  completed: 'completed',
  stopped: 'stopped',
  errored: 'errored',
  all: 'all',
} as const

const FILTER_LABELS: Record<keyof typeof FILTERS, string> = {
  active: 'активные',
  downloading: 'качаются',
  completed: 'готовы',
  stopped: 'остановлены',
  errored: 'с ошибкой',
  all: 'все',
}

const hashesInput = z
  .array(z.string().min(1))
  .min(1)
  .describe('Hash торрентов из torrents_status (достаточно первых 8 символов) или ["all"] для всех')

async function resolveRefs(c: Config, refs: string[]): Promise<{ targets: QbTorrent[] | 'all' }> {
  if (refs.length === 1 && refs[0]!.toLowerCase() === 'all') return { targets: 'all' }
  return { targets: matchTorrents(await client(c).torrents(), refs) }
}

function namesLine(targets: QbTorrent[] | 'all'): string {
  if (targets === 'all') return 'все торренты'
  return targets.map((t) => truncate(t.name, 50)).join(', ')
}

export const qbittorrent = defineConnector<Config>({
  id: 'qbittorrent',
  name: 'qBittorrent',
  description: 'Закачки на NAS',
  docsUrl: 'https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-5.0)',
  configSchema,

  async test(c) {
    const started = Date.now()
    try {
      const qb = client(c)
      const [version, api, torrents] = await Promise.all([qb.version(), qb.webapiVersion(), qb.torrents()])
      return {
        ok: true,
        version,
        summary: `qBittorrent ${version}`,
        details: [`WebAPI ${api}`, `${torrents.length} ${plural(torrents.length, ['торрент', 'торрента', 'торрентов'])}`, `ответ ${Date.now() - started} мс`],
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'torrents_status',
      title: 'Статус закачек',
      description: 'Список торрентов в qBittorrent: прогресс, скорость, сколько осталось, сиды, состояние и hash.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        filter: z.enum(['active', 'downloading', 'completed', 'stopped', 'errored', 'all']).default('active').describe('Какие торренты показать'),
        category: z.string().optional().describe('Только эта категория'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      async run({ filter, category, limit }, { config }) {
        const list = await client(config).torrents({ filter: FILTERS[filter], category, sort: 'added_on', reverse: true })
        const label = FILTER_LABELS[filter]
        if (list.length === 0) return `Нет торрентов (${label}).`
        const shown = list.slice(0, limit)
        const head = `${list.length} ${plural(list.length, ['торрент', 'торрента', 'торрентов'])} (${label})${list.length > shown.length ? `, показаны ${shown.length}` : ''}:`
        return [head, ...shown.map(formatTorrentLine)].join('\n')
      },
    }),

    tool({
      name: 'torrent_add',
      title: 'Добавить закачку',
      description:
        'Добавить торрент в qBittorrent. Предпочтительно по result_id из search_torrents; можно по магнет-ссылке или URL .torrent. Возвращает hash.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        result_id: z.string().optional().describe('result_id из search_torrents'),
        url: z.string().optional().describe('Магнет-ссылка или http(s) URL .torrent, если result_id нет'),
        category: z.string().optional().describe('Категория; по умолчанию — из настроек хаба'),
        save_path: z.string().optional().describe('Папка сохранения; по умолчанию — из настроек хаба'),
        stopped: z.boolean().optional().describe('Добавить остановленным'),
      }),
      async run(args, { config, resolveResult }) {
        const { result_id, url } = args
        if (!result_id && !url) throw new ToolError('Нужен result_id из search_torrents или url')
        const qb = client(config)
        const category = args.category ?? config.defaultCategory
        const savePath = args.save_path ?? config.savePath
        const stopped = args.stopped ?? config.addStopped

        let title = url ?? ''
        let hash: string | null = null
        let payload: { urls?: string; file?: { data: Uint8Array; filename: string } }
        if (result_id) {
          const r = await resolveResult(result_id)
          title = r.title
          if (r.kind === 'magnet') {
            payload = { urls: r.uri }
            hash = r.infoHash ?? magnetInfoHash(r.uri)
          } else {
            payload = { file: { data: r.data, filename: r.filename } }
            hash = r.infoHash ?? torrentInfoHash(r.data)
          }
        } else {
          payload = { urls: url }
          hash = url && url.startsWith('magnet:') ? magnetInfoHash(url) : null
        }

        if (hash) {
          const existing = await qb.torrents({ hashes: [hash] })
          if (existing[0]) return `Уже в списке: ${truncate(existing[0].name, 70)} · ${Math.floor(existing[0].progress * 100)}% · hash ${shortHash(hash)}`
        }

        await qb.add({ ...payload, category, savePath, stopped })
        const extras = [category && `категория ${category}`, stopped && 'остановлен', hash && `hash ${shortHash(hash)}`].filter(Boolean)
        return `Добавлено: ${truncate(title, 80)}${extras.length ? ` · ${extras.join(' · ')}` : ''}`
      },
    }),

    tool({
      name: 'torrent_stop',
      title: 'Остановить закачку',
      description: 'Остановить торренты по hash или все.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ hashes: hashesInput }),
      async run({ hashes }, { config }) {
        const { targets } = await resolveRefs(config, hashes)
        await client(config).stop(targets === 'all' ? 'all' : targets.map((t) => t.hash))
        return `Остановлено: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'torrent_start',
      title: 'Запустить закачку',
      description: 'Запустить (возобновить) торренты по hash или все.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ hashes: hashesInput }),
      async run({ hashes }, { config }) {
        const { targets } = await resolveRefs(config, hashes)
        await client(config).start(targets === 'all' ? 'all' : targets.map((t) => t.hash))
        return `Запущено: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'torrent_delete',
      title: 'Удалить торрент',
      description:
        'Удалить торренты из qBittorrent. По умолчанию файлы остаются на диске. Удаление вместе с файлами (delete_files: true) необратимо: сначала переспроси пользователя и передай confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        hashes: z.array(z.string().min(1)).min(1).describe('Hash торрентов из torrents_status'),
        delete_files: z.boolean().default(false).describe('Удалить и скачанные файлы с диска'),
        confirm: z.boolean().optional().describe('true — пользователь подтвердил удаление вместе с файлами'),
      }),
      async run({ hashes, delete_files, confirm }, { config }) {
        const refs = hashes
        if (refs.some((h) => h.toLowerCase() === 'all')) throw new ToolError('Удалять «все» нельзя — перечисли hash')
        const targets = matchTorrents(await client(config).torrents(), refs)
        if (delete_files && confirm !== true) {
          return `Не удалено. Удаление с файлами необратимо — переспроси пользователя и повтори с confirm: true.\nБудут удалены: ${namesLine(targets)}`
        }
        await client(config).delete(
          targets.map((t) => t.hash),
          delete_files,
        )
        return `Удалено${delete_files ? ' вместе с файлами' : ' из списка (файлы на диске)'}: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'torrent_files',
      title: 'Файлы торрента',
      description: 'Файлы внутри торрента с размером и прогрессом — например, серии сезона.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ hash: z.string().min(1).describe('Hash торрента из torrents_status'), limit: z.number().int().min(1).max(100).default(40) }),
      async run({ hash, limit }, { config }) {
        const qb = client(config)
        const [t] = matchTorrents(await qb.torrents(), [hash])
        const files = await qb.files(t!.hash)
        const shown = files.slice(0, limit)
        const lines = shown.map((f) => {
          const skip = f.priority === 0 ? ' · не качается' : ''
          return `• ${truncate(f.name.split('/').pop() ?? f.name, 70)} — ${Math.floor(f.progress * 100)}% · ${formatSize(f.size)}${skip}`
        })
        const more = files.length > shown.length ? `\n…и ещё ${files.length - shown.length}` : ''
        return `${truncate(t!.name, 70)} — ${files.length} ${plural(files.length, ['файл', 'файла', 'файлов'])}:\n${lines.join('\n')}${more}`
      },
    }),

    tool({
      name: 'transfer_info',
      title: 'Скорость и диск',
      description: 'Общая скорость загрузки и отдачи, состояние соединения и свободное место на диске.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const qb = client(config)
        const [info, free] = await Promise.all([qb.transferInfo(), qb.freeSpace().catch(() => null)])
        const conn: Record<string, string> = { connected: 'подключено', firewalled: 'за файрволом', disconnected: 'нет соединения' }
        return [
          `↓ ${formatSpeed(info.dl_info_speed)} · ↑ ${formatSpeed(info.up_info_speed)}`,
          `Соединение: ${conn[info.connection_status] ?? info.connection_status} · DHT ${info.dht_nodes} узлов`,
          free !== null ? `Свободно на диске: ${formatSize(free)}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),
  ],
})
