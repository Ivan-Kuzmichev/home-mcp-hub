import { z } from 'zod'
import { formatSize, plural, truncate } from '../format'
import { baseUrl, defineConnector, field, secret, toolFor, ToolError } from '../types'
import { TsClient, type TsFile, type TsTorrent } from './client'

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Адрес для хаба', placeholder: 'http://torrserve:8090', help: 'По этому адресу хаб ходит в API — обычно имя контейнера' }),
    streamUrl: field(
      z
        .string()
        .trim()
        .url('Нужен адрес вида http://192.168.1.10:8090')
        .transform((v) => v.replace(/\/+$/, ''))
        .optional(),
      {
        label: 'Адрес для плееров',
        placeholder: 'http://192.168.1.10:8090',
        help: 'Домашний адрес TorrServe для ссылок на стрим (телевизор, VLC). Пусто — как адрес для хаба',
        widget: 'url',
        mono: true,
        section: 'connection',
      },
    ),
    authMode: field(z.enum(['none', 'basic']).default('none'), {
      label: 'Способ входа',
      widget: 'segmented',
      section: 'connection',
      options: [
        { value: 'none', label: 'Без авторизации', short: 'Без входа', help: 'По умолчанию TorrServe работает без пароля.' },
        { value: 'basic', label: 'Логин и пароль', short: 'Логин', help: 'Если TorrServe запущен с --httpauth: логин и пароль из accs.db.' },
      ],
    }),
    username: field(z.string().trim().optional(), { label: 'Логин', section: 'connection', showWhen: { field: 'authMode', equals: ['basic'] } }),
    password: secret({ label: 'Пароль', section: 'connection', showWhen: { field: 'authMode', equals: ['basic'] } }),
    saveToDb: field(z.boolean().default(true), {
      label: 'Сохранять в базу TorrServe',
      help: 'Торрент останется в списке после перезапуска',
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
const client = (c: Config) => new TsClient(c)
const short = (hash: string) => hash.slice(0, 8)
const VIDEO = /\.(mkv|mp4|avi|m4v|mov|ts|m2ts|webm|wmv)$/i

function match(list: TsTorrent[], ref: string): TsTorrent {
  const r = ref.trim().toLowerCase()
  const byHash = list.filter((t) => t.hash.toLowerCase().startsWith(r))
  const matches = byHash.length ? byHash : list.filter((t) => t.title.toLowerCase().includes(r))
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new ToolError(`В TorrServe нет «${ref}» — посмотри torrserve_list`)
  throw new ToolError(`«${ref}» подходит к нескольким:\n${matches.slice(0, 5).map((t) => `• ${truncate(t.title, 60)} · hash ${short(t.hash)}`).join('\n')}`)
}

export function streamLinks(c: Config, t: TsTorrent): { playlist: string; files: { file: TsFile; url: string }[] } {
  const base = c.streamUrl ?? c.baseUrl
  const files = (t.file_stats ?? []).filter((f) => VIDEO.test(f.path))
  return {
    playlist: `${base}/stream/${encodeURIComponent(truncate(t.title || 'playlist', 60))}.m3u?link=${t.hash}&m3u`,
    files: files.map((file) => ({
      file,
      url: `${base}/stream/${encodeURIComponent(file.path.split('/').pop() ?? 'video')}?link=${t.hash}&index=${file.id}&play`,
    })),
  }
}

export const torrserve = defineConnector<Config>({
  id: 'torrserve',
  name: 'TorrServe',
  description: 'Стриминг торрентов',
  docsUrl: 'https://github.com/YouROK/TorrServer',
  configSchema,

  async test(c) {
    const started = Date.now()
    try {
      const ts = client(c)
      const [version, list] = await Promise.all([ts.version(), ts.list()])
      return {
        ok: true,
        version,
        summary: `TorrServe ${version}`,
        details: [`${list.length} в базе`, `ответ ${Date.now() - started} мс`],
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'torrserve_add',
      title: 'Добавить в TorrServe',
      description: 'Добавить торрент в TorrServe для просмотра без скачивания. Предпочтительно по result_id из search_torrents. Потом torrserve_links даст ссылки на плеер.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        result_id: z.string().optional().describe('result_id из search_torrents'),
        url: z.string().optional().describe('Магнет-ссылка или hash, если result_id нет'),
        title: z.string().optional().describe('Название для списка TorrServe'),
        poster: z.string().url().optional().describe('URL постера'),
      }),
      async run(args, { config, resolveResult }) {
        if (!args.result_id && !args.url) throw new ToolError('Нужен result_id из search_torrents или url')
        const ts = client(config)
        let added: TsTorrent
        if (args.result_id) {
          const r = await resolveResult(args.result_id)
          const title = args.title ?? r.title
          added =
            r.kind === 'magnet'
              ? await ts.add({ link: r.uri, title, poster: args.poster, saveToDb: config.saveToDb })
              : await ts.upload({ data: r.data, filename: r.filename, title, poster: args.poster, saveToDb: config.saveToDb })
        } else {
          added = await ts.add({ link: args.url!, title: args.title, poster: args.poster, saveToDb: config.saveToDb })
        }
        if (!added?.hash) throw new ToolError('TorrServe не вернул hash — проверь ссылку')
        return `Добавлено в TorrServe: ${truncate(added.title || args.title || '', 80)} · hash ${short(added.hash)}\nСсылки на плеер — torrserve_links.`
      },
    }),

    tool({
      name: 'torrserve_list',
      title: 'Список TorrServe',
      description: 'Что уже добавлено в TorrServe: название, размер, состояние, hash.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      async run({ limit }, { config }) {
        const list = await client(config).list()
        if (list.length === 0) return 'TorrServe пуст.'
        const lines = list.slice(0, limit).map((t) => {
          const parts = [t.torrent_size ? formatSize(t.torrent_size) : null, t.stat_string, `hash ${short(t.hash)}`].filter(Boolean)
          return `• ${truncate(t.title, 70)} — ${parts.join(' · ')}`
        })
        return [`В TorrServe ${list.length} ${plural(list.length, ['торрент', 'торрента', 'торрентов'])}:`, ...lines].join('\n')
      },
    }),

    tool({
      name: 'torrserve_links',
      title: 'Ссылки на стрим',
      description: 'Ссылка на плейлист M3U и прямые ссылки на видеофайлы торрента в TorrServe. Работают из домашней сети или по VPN.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        hash: z.string().min(1).describe('Hash из torrserve_list или torrserve_add (достаточно 8 символов)'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      async run({ hash, limit }, { config }) {
        const ts = client(config)
        const t = match(await ts.list(), hash)
        const full = await ts.get(t.hash)
        const links = streamLinks(config, { ...t, ...full, title: full.title || t.title })
        const lines = [`${truncate(full.title || t.title, 70)}`, `Плейлист: ${links.playlist}`]
        if (links.files.length === 0) {
          lines.push(full.file_stats?.length ? 'Видеофайлов нет.' : 'Файлы ещё не известны — TorrServe получает метаданные, повтори через минуту.')
        } else {
          lines.push(...links.files.slice(0, limit).map(({ file, url }) => `• ${truncate(file.path.split('/').pop() ?? '', 60)} (${formatSize(file.length)}): ${url}`))
          if (links.files.length > limit) lines.push(`…и ещё ${links.files.length - limit} — есть в плейлисте`)
        }
        if (config.authMode === 'basic') lines.push('TorrServe с паролем: плеер спросит логин.')
        return lines.join('\n')
      },
    }),

    tool({
      name: 'torrserve_remove',
      title: 'Убрать из TorrServe',
      description: 'Убрать торрент из базы TorrServe. Файлов на диске это не касается — TorrServe хранит только кэш.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ hash: z.string().min(1).describe('Hash из torrserve_list') }),
      async run({ hash }, { config }) {
        const ts = client(config)
        const t = match(await ts.list(), hash)
        await ts.remove(t.hash)
        return `Убрано из TorrServe: ${truncate(t.title, 70)}`
      },
    }),
  ],
})
