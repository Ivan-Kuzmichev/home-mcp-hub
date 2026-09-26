import { z } from 'zod'
import { magnetInfoHash, torrentInfoHash } from '../bencode'
import { formatEta, formatSize, formatSpeed, plural, truncate } from '../format'
import { matchTorrents, shortHash } from '../torrents'
import { baseUrl, defineConnector, field, secret, toolFor, ToolError } from '../types'
import { TrClient, type TrTorrent } from './client'

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Адрес в локальной сети', placeholder: 'http://transmission:9091' }),
    rpcPath: field(z.string().trim().startsWith('/', 'Путь начинается с /').default('/transmission/rpc'), {
      label: 'Путь RPC',
      placeholder: '/transmission/rpc',
      mono: true,
      section: 'connection',
    }),
    authMode: field(z.enum(['none', 'basic']).default('none'), {
      label: 'Способ входа',
      widget: 'segmented',
      section: 'connection',
      options: [
        {
          value: 'none',
          label: 'Без авторизации',
          short: 'Без входа',
          help: 'rpc-authentication-required выключен. В settings.json Transmission добавь подсеть хаба в rpc-whitelist (или выключи rpc-whitelist-enabled).',
          showHubNetwork: true,
        },
        { value: 'basic', label: 'Логин и пароль', short: 'Логин', help: 'rpc-username и rpc-password из settings.json Transmission.' },
      ],
    }),
    username: field(z.string().trim().optional(), { label: 'Логин', section: 'connection', showWhen: { field: 'authMode', equals: ['basic'] } }),
    password: secret({ label: 'Пароль', section: 'connection', showWhen: { field: 'authMode', equals: ['basic'] } }),
    defaultLabel: field(z.string().trim().optional(), { label: 'Метка по умолчанию', placeholder: 'claude', help: 'Transmission 3.0+', section: 'defaults' }),
    downloadDir: field(z.string().trim().optional(), { label: 'Папка сохранения', placeholder: '/downloads/claude', mono: true, section: 'defaults' }),
    addPaused: field(z.boolean().default(false), {
      label: 'Добавлять торренты остановленными',
      help: 'Claude сам вызовет transmission_start',
      widget: 'switch',
      section: 'defaults',
    }),
  })
  .superRefine((c, ctx) => {
    if (c.authMode === 'basic') {
      if (!c.username) ctx.addIssue({ code: 'custom', path: ['username'], message: 'Нужен логин' })
      if (!c.password) ctx.addIssue({ code: 'custom', path: ['password'], message: 'Нужен пароль' })
    }
  })

type Config = z.output<typeof configSchema>

const tool = toolFor<Config>()
const client = (c: Config) => new TrClient(c)

// Transmission status codes
const STATUS_LABELS: Record<number, string> = {
  0: 'остановлен',
  1: 'ждёт проверки',
  2: 'проверка',
  3: 'в очереди',
  4: 'качается',
  5: 'в очереди на раздачу',
  6: 'раздаётся',
}

type Row = TrTorrent & { hash: string }
const rows = (list: TrTorrent[]): Row[] => list.map((t) => ({ ...t, hash: t.hashString }))

function statusLabel(t: TrTorrent): string {
  if (t.error) return `ошибка: ${truncate(t.errorString, 60)}`
  if (t.status === 0 && t.percentDone >= 1) return 'готов'
  return STATUS_LABELS[t.status] ?? String(t.status)
}

export function formatTransmissionLine(t: TrTorrent): string {
  const pct = Math.floor(t.percentDone * 100)
  const parts = [`${pct}%`]
  if (t.percentDone < 1 && t.rateDownload > 0) parts.push(`↓ ${formatSpeed(t.rateDownload)}`, `осталось ${t.eta >= 0 ? formatEta(t.eta) : '∞'}`)
  if (t.rateUpload > 0) parts.push(`↑ ${formatSpeed(t.rateUpload)}`)
  parts.push(`пиры ${t.peersSendingToUs}/${t.peersConnected}`, formatSize(t.totalSize), statusLabel(t))
  return `• ${truncate(t.name, 70)} — ${parts.join(' · ')} · hash ${shortHash(t.hashString)}`
}

const FILTERS = {
  active: (t: TrTorrent) => t.rateDownload > 0 || t.rateUpload > 0 || t.status === 4,
  downloading: (t: TrTorrent) => t.status === 3 || t.status === 4,
  completed: (t: TrTorrent) => t.percentDone >= 1,
  stopped: (t: TrTorrent) => t.status === 0,
  errored: (t: TrTorrent) => t.error !== 0,
  all: () => true,
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
  .describe('Hash торрентов из transmission_status (достаточно первых 8 символов) или ["all"] для всех')

async function resolveRefs(c: Config, refs: string[]): Promise<Row[] | 'all'> {
  if (refs.length === 1 && refs[0]!.toLowerCase() === 'all') return 'all'
  return matchTorrents(rows(await client(c).torrents()), refs, 'transmission_status')
}

function namesLine(targets: Row[] | 'all'): string {
  return targets === 'all' ? 'все торренты' : targets.map((t) => truncate(t.name, 50)).join(', ')
}

export const transmission = defineConnector<Config>({
  id: 'transmission',
  name: 'Transmission',
  description: 'Закачки на NAS (Transmission)',
  docsUrl: 'https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md',
  configSchema,

  async test(c) {
    const started = Date.now()
    try {
      const tr = client(c)
      const [v, list] = await Promise.all([tr.version(), tr.torrents()])
      return {
        ok: true,
        version: v.version,
        summary: `Transmission ${v.version.split(' ')[0]}`,
        details: [`RPC ${v.rpc}`, `${list.length} ${plural(list.length, ['торрент', 'торрента', 'торрентов'])}`, `ответ ${Date.now() - started} мс`],
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'transmission_status',
      title: 'Статус закачек Transmission',
      description: 'Список торрентов в Transmission: прогресс, скорость, сколько осталось, пиры, состояние и hash.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        filter: z.enum(['active', 'downloading', 'completed', 'stopped', 'errored', 'all']).default('active').describe('Какие торренты показать'),
        label: z.string().optional().describe('Только с этой меткой'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      async run({ filter, label, limit }, { config }) {
        const list = (await client(config).torrents())
          .filter(FILTERS[filter])
          .filter((t) => !label || (t.labels ?? []).includes(label))
          .sort((a, b) => b.addedDate - a.addedDate)
        if (list.length === 0) return `Нет торрентов (${FILTER_LABELS[filter]}).`
        const shown = list.slice(0, limit)
        const head = `${list.length} ${plural(list.length, ['торрент', 'торрента', 'торрентов'])} (${FILTER_LABELS[filter]})${list.length > shown.length ? `, показаны ${shown.length}` : ''}:`
        return [head, ...shown.map(formatTransmissionLine)].join('\n')
      },
    }),

    tool({
      name: 'transmission_add',
      title: 'Добавить в Transmission',
      description: 'Добавить торрент в Transmission. Предпочтительно по result_id из search_torrents; можно по магнет-ссылке или URL .torrent. Возвращает hash.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        result_id: z.string().optional().describe('result_id из search_torrents'),
        url: z.string().optional().describe('Магнет-ссылка или http(s) URL .torrent, если result_id нет'),
        label: z.string().optional().describe('Метка; по умолчанию — из настроек хаба'),
        download_dir: z.string().optional().describe('Папка сохранения; по умолчанию — из настроек хаба'),
        paused: z.boolean().optional().describe('Добавить остановленным'),
      }),
      async run(args, { config, resolveResult }) {
        if (!args.result_id && !args.url) throw new ToolError('Нужен result_id из search_torrents или url')
        const label = args.label ?? config.defaultLabel
        const input = { downloadDir: args.download_dir ?? config.downloadDir, paused: args.paused ?? config.addPaused, labels: label ? [label] : undefined }
        let title = args.url ?? ''
        let added
        if (args.result_id) {
          const r = await resolveResult(args.result_id)
          title = r.title
          added = await client(config).add(r.kind === 'magnet' ? { ...input, magnetOrUrl: r.uri } : { ...input, metainfo: r.data })
          // Some versions report no hash for URL adds; fall back to what we know.
          added.hash ||= r.kind === 'magnet' ? (r.infoHash ?? magnetInfoHash(r.uri) ?? '') : (r.infoHash ?? torrentInfoHash(r.data) ?? '')
        } else {
          added = await client(config).add({ ...input, magnetOrUrl: args.url })
        }
        if (added.duplicate) return `Уже в списке: ${truncate(added.name || title, 70)} · hash ${shortHash(added.hash)}`
        const extras = [label && `метка ${label}`, input.paused && 'остановлен', added.hash && `hash ${shortHash(added.hash)}`].filter(Boolean)
        return `Добавлено: ${truncate(title || added.name, 80)}${extras.length ? ` · ${extras.join(' · ')}` : ''}`
      },
    }),

    tool({
      name: 'transmission_stop',
      title: 'Остановить в Transmission',
      description: 'Остановить торренты в Transmission по hash или все.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ hashes: hashesInput }),
      async run({ hashes }, { config }) {
        const targets = await resolveRefs(config, hashes)
        await client(config).stop(targets === 'all' ? 'all' : targets.map((t) => t.hashString))
        return `Остановлено: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'transmission_start',
      title: 'Запустить в Transmission',
      description: 'Запустить (возобновить) торренты в Transmission по hash или все.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ hashes: hashesInput }),
      async run({ hashes }, { config }) {
        const targets = await resolveRefs(config, hashes)
        await client(config).start(targets === 'all' ? 'all' : targets.map((t) => t.hashString))
        return `Запущено: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'transmission_delete',
      title: 'Удалить из Transmission',
      description:
        'Удалить торренты из Transmission. По умолчанию файлы остаются на диске. Удаление вместе с файлами (delete_files: true) необратимо: сначала переспроси пользователя и передай confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        hashes: z.array(z.string().min(1)).min(1).describe('Hash торрентов из transmission_status'),
        delete_files: z.boolean().default(false).describe('Удалить и скачанные файлы с диска'),
        confirm: z.boolean().optional().describe('true — пользователь подтвердил удаление вместе с файлами'),
      }),
      async run({ hashes, delete_files, confirm }, { config }) {
        if (hashes.some((h) => h.toLowerCase() === 'all')) throw new ToolError('Удалять «все» нельзя — перечисли hash')
        const targets = matchTorrents(rows(await client(config).torrents()), hashes, 'transmission_status')
        if (delete_files && confirm !== true) {
          return `Не удалено. Удаление с файлами необратимо — переспроси пользователя и повтори с confirm: true.\nБудут удалены: ${namesLine(targets)}`
        }
        await client(config).remove(
          targets.map((t) => t.hashString),
          delete_files,
        )
        return `Удалено${delete_files ? ' вместе с файлами' : ' из списка (файлы на диске)'}: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'transmission_files',
      title: 'Файлы торрента в Transmission',
      description: 'Файлы внутри торрента в Transmission с размером и прогрессом — например, серии сезона.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ hash: z.string().min(1).describe('Hash торрента из transmission_status'), limit: z.number().int().min(1).max(100).default(40) }),
      async run({ hash, limit }, { config }) {
        const tr = client(config)
        const [t] = matchTorrents(rows(await tr.torrents()), [hash], 'transmission_status')
        const { files, wanted } = await tr.files(t!.hashString)
        const lines = files.slice(0, limit).map((f, i) => {
          const pct = f.length ? Math.floor((f.bytesCompleted / f.length) * 100) : 100
          return `• ${truncate(f.name.split('/').pop() ?? f.name, 70)} — ${pct}% · ${formatSize(f.length)}${wanted[i] === false ? ' · не качается' : ''}`
        })
        const more = files.length > limit ? `\n…и ещё ${files.length - limit}` : ''
        return `${truncate(t!.name, 70)} — ${files.length} ${plural(files.length, ['файл', 'файла', 'файлов'])}:\n${lines.join('\n')}${more}`
      },
    }),

    tool({
      name: 'transmission_info',
      title: 'Скорость и диск Transmission',
      description: 'Общая скорость загрузки и отдачи Transmission, число активных торрентов и свободное место в папке загрузок.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const tr = client(config)
        const [s, free] = await Promise.all([tr.stats(), tr.freeSpace()])
        return [
          `↓ ${formatSpeed(s.downloadSpeed)} · ↑ ${formatSpeed(s.uploadSpeed)}`,
          `Активных: ${s.activeTorrentCount} из ${s.torrentCount}`,
          free !== null ? `Свободно на диске: ${formatSize(free)}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),
  ],
})
