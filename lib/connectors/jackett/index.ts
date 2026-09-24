import { z } from 'zod'
import { cacheResults } from '../../mcp/result-cache'
import { formatAgo } from '../../format'
import { plural } from '../format'
import { baseUrl, defineConnector, field, secret, toolFor, ToolError } from '../types'
import { JackettClient, type Indexer } from './client'
import { formatRelease, indexerHealth, searchAll, toCached } from './search'

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Адрес в локальной сети', placeholder: 'http://jackett:9117' }),
    apiKey: secret({ label: 'API-ключ', help: 'Правый верхний угол веб-интерфейса Jackett', section: 'connection' }),
    minSeeders: field(z.coerce.number().int().min(0).max(1000).default(1), {
      label: 'Минимум сидов по умолчанию',
      widget: 'number',
      section: 'defaults',
    }),
  })
  .superRefine((c, ctx) => {
    if (!c.apiKey) ctx.addIssue({ code: 'custom', path: ['apiKey'], message: 'Jackett без API-ключа не работает' })
  })

type Config = z.output<typeof configSchema>

const tool = toolFor<Config>()
const client = (c: Config) => new JackettClient({ baseUrl: c.baseUrl, apiKey: c.apiKey ?? '' })

// The indexer list rarely changes; keep it for 5 minutes.
const indexerCache = new Map<string, { at: number; list: Indexer[] }>()
async function indexers(c: Config): Promise<Indexer[]> {
  const cached = indexerCache.get(c.baseUrl)
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.list
  const list = await client(c).indexers()
  indexerCache.set(c.baseUrl, { at: Date.now(), list })
  return list
}

export const jackett = defineConnector<Config>({
  id: 'jackett',
  name: 'Jackett',
  description: 'Поиск по торрент-трекерам',
  docsUrl: 'https://github.com/Jackett/Jackett',
  configSchema,

  async test(c) {
    const started = Date.now()
    try {
      indexerCache.delete(c.baseUrl)
      const [list, version] = await Promise.all([indexers(c), client(c).version()])
      return {
        ok: true,
        version: version ?? undefined,
        summary: `${list.length} ${plural(list.length, ['индексатор', 'индексатора', 'индексаторов'])}`,
        details: [version ? `Jackett ${version}` : null, `ответ ${Date.now() - started} мс`].filter((d): d is string => !!d),
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'search_torrents',
      title: 'Поиск торрентов',
      description:
        'Поиск фильмов и сериалов по всем трекерам Jackett. Возвращает релизы с result_id — передай его в torrent_add или torrserve_add. Одинаковые раздачи склеены, по одному релизу на трекер и качество.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        query: z.string().min(1).describe('Название, лучше оригинальное или как на трекерах'),
        type: z.enum(['movie', 'tv', 'anime', 'any']).default('any').describe('Фильм, сериал, аниме или любое'),
        season: z.number().int().min(0).max(100).optional().describe('Номер сезона для сериалов'),
        episode: z.number().int().min(0).max(1000).optional().describe('Номер серии'),
        year: z.number().int().min(1900).max(2100).optional().describe('Год выхода — уточняет поиск'),
        language: z.enum(['ru', 'any']).default('ru').describe('ru — сначала релизы с русской озвучкой'),
        min_seeders: z.number().int().min(0).optional().describe('Минимум сидов; по умолчанию из настроек хаба'),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      async run(args, { config }) {
        const list = await indexers(config)
        if (list.length === 0) throw new ToolError('В Jackett нет настроенных индексаторов')
        const out = await searchAll(client(config), list, {
          query: args.query,
          type: args.type,
          season: args.season,
          episode: args.episode,
          year: args.year,
          language: args.language,
          minSeeders: args.min_seeders ?? config.minSeeders,
          limit: args.limit,
        })

        const timedOut = out.failed.filter((f) => f.reason === 'timeout').map((f) => f.name)
        const errored = out.failed.filter((f) => f.reason === 'error').map((f) => f.name)
        const notes = [
          timedOut.length ? `Не ответили за 25 с: ${timedOut.join(', ')}.` : null,
          errored.length ? `Ошибка: ${errored.join(', ')}.` : null,
        ].filter(Boolean)

        if (out.releases.length === 0) {
          return [`Ничего не найдено по «${args.query}»${args.season !== undefined ? `, сезон ${args.season}` : ''}.`, ...notes, 'Попробуй другое написание или оригинальное название.'].join('\n')
        }
        const ids = cacheResults('jackett', out.releases.map(toCached))
        const head = `Найдено ${out.total}, показаны ${out.releases.length} лучших:`
        return [head, ...out.releases.map((r, i) => formatRelease(ids[i]!, r)), ...notes].join('\n')
      },
    }),

    tool({
      name: 'list_indexers',
      title: 'Трекеры Jackett',
      description: 'Какие трекеры настроены в Jackett и отвечали ли они при последнем поиске — чтобы понять, почему ничего не нашлось.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const list = await indexers(config)
        if (list.length === 0) return 'В Jackett нет настроенных индексаторов.'
        const lines = list.map((ix) => {
          const h = indexerHealth.get(ix.id)
          if (!h) return `• ${ix.name} — ещё не опрашивался`
          return `• ${ix.name} — ${h.ok ? 'отвечал' : `ошибка: ${h.note ?? ''}`} ${formatAgo(h.at)}`
        })
        return [`${list.length} ${plural(list.length, ['индексатор', 'индексатора', 'индексаторов'])}:`, ...lines].join('\n')
      },
    }),
  ],
})
