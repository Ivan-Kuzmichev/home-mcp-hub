import { z } from 'zod'
import { t } from '../../i18n'
import { cacheResults } from '../../mcp/result-cache'
import { formatAgo } from '../../format'
import { plural } from '../format'
import { baseUrl, defineConnector, field, secret, toolFor, ToolError } from '../types'
import { JackettClient, type Indexer } from './client'
import { AUDIO_LANGS, type AudioLang } from './parse'
import { formatRelease, indexerHealth, searchAll, toCached } from './search'

const isAudioLang = (v: string): v is AudioLang => (AUDIO_LANGS as readonly string[]).includes(v)
const LANG_LIST = AUDIO_LANGS.join(', ')

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Address on the local network', placeholder: 'http://jackett:9117' }),
    apiKey: secret({ label: 'API key', help: 'Top right corner of the Jackett web interface', section: 'connection' }),
    minSeeders: field(z.coerce.number().int().min(0).max(1000).default(1), {
      label: 'Default minimum seeders',
      widget: 'number',
      section: 'defaults',
    }),
    audioLanguage: field(
      z
        .string()
        .trim()
        .toLowerCase()
        .default('en')
        .refine(isAudioLang, { error: (iss) => t`Unknown language “${String(iss.input)}”. Available: ${LANG_LIST}` }),
      {
        label: 'Preferred audio language',
        help: 'Releases with this audio go first: en, ru, uk, de, fr, es, it, pl. en — no preference, by seeders',
        placeholder: 'en',
        mono: true,
        section: 'defaults',
      },
    ),
  })
  .superRefine((c, ctx) => {
    if (!c.apiKey) ctx.addIssue({ code: 'custom', path: ['apiKey'], message: t`Jackett does not work without an API key` })
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
  description: 'Torrent tracker search',
  docsUrl: 'https://github.com/Jackett/Jackett',
  configSchema,

  instructions(_c, { tools }) {
    const add = [
      ['torrent_add', 'qBittorrent'],
      ['transmission_add', 'Transmission'],
      ['torrserve_add', t`TorrServe — watch without downloading`],
    ].filter(([t]) => tools.includes(t!))
    // The choice rule goes first: it exists only here, the flow is also in the tool descriptions.
    const choose = t`Releases: other things equal, prefer the audio language from the settings and more than 10 seeders; if several fit and differ noticeably, ask.`
    const flow = add.length
      ? t`To download: search_torrents, then ${add.map(([t, what]) => `${t} (${what})`).join(t` or `)} with the result_id. Do not retype magnets and links.`
      : t`search_torrents finds releases; there is no download client now — only show what was found.`
    return [choose, flow].join('\n')
  },

  async test(c) {
    const started = Date.now()
    try {
      indexerCache.delete(c.baseUrl)
      const [list, version] = await Promise.all([indexers(c), client(c).version()])
      return {
        ok: true,
        version: version ?? undefined,
        summary: `${list.length} ${plural(list.length, ['indexer', 'indexers'])}`,
        details: [version ? `Jackett ${version}` : null, t`response ${Date.now() - started} ms`].filter((d): d is string => !!d),
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'search_torrents',
      title: 'Torrent search',
      description:
        'Search movies and series on all Jackett trackers. Returns releases with a result_id — pass it to torrent_add or torrserve_add. Identical releases are merged, one release per tracker and quality.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        query: z.string().min(1).describe('Title, preferably the original one or as on the trackers'),
        type: z.enum(['movie', 'tv', 'anime', 'any']).default('any').describe('Movie, series, anime or any'),
        season: z.number().int().min(0).max(100).optional().describe('Season number for series'),
        episode: z.number().int().min(0).max(1000).optional().describe('Episode number'),
        year: z.number().int().min(1900).max(2100).optional().describe('Release year — narrows the search'),
        language: z
          .string()
          .trim()
          .toLowerCase()
          .refine((v) => v === 'any' || isAudioLang(v), { error: () => t`Language: one of ${LANG_LIST} or any` })
          .optional()
          .describe('Audio language to put first (en, ru, uk, de, fr, es, it, pl) or any; by default from the hub settings'),
        min_seeders: z.number().int().min(0).optional().describe('Minimum seeders; by default from the hub settings'),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      async run(args, { config }) {
        const list = await indexers(config)
        if (list.length === 0) throw new ToolError(t`Jackett has no configured indexers`)
        const out = await searchAll(client(config), list, {
          query: args.query,
          type: args.type,
          season: args.season,
          episode: args.episode,
          year: args.year,
          language: (args.language ?? config.audioLanguage) as AudioLang | 'any',
          minSeeders: args.min_seeders ?? config.minSeeders,
          limit: args.limit,
        })

        const timedOut = out.failed.filter((f) => f.reason === 'timeout').map((f) => f.name)
        const errored = out.failed.filter((f) => f.reason === 'error').map((f) => f.name)
        const notes = [
          timedOut.length ? t`Did not respond in 25 s: ${timedOut.join(', ')}.` : null,
          errored.length ? t`Error: ${errored.join(', ')}.` : null,
        ].filter(Boolean)

        if (out.releases.length === 0) {
          return [t`Nothing found for “${args.query}”${args.season !== undefined ? t`, season ${args.season}` : ''}.`, ...notes, t`Try another spelling or the original title.`].join('\n')
        }
        const ids = cacheResults('jackett', out.releases.map(toCached))
        const head = t`Found ${out.total}, showing the best ${out.releases.length}:`
        return [head, ...out.releases.map((r, i) => formatRelease(ids[i]!, r)), ...notes].join('\n')
      },
    }),

    tool({
      name: 'list_indexers',
      title: 'Jackett trackers',
      description: 'Which trackers are configured in Jackett and whether they responded in the last search — to see why nothing was found.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const list = await indexers(config)
        if (list.length === 0) return t`Jackett has no configured indexers.`
        const lines = list.map((ix) => {
          const h = indexerHealth.get(ix.id)
          if (!h) return t`• ${ix.name} — not queried yet`
          return `• ${ix.name} — ${h.ok ? t`responded` : t`error: ${h.note ?? ''}`} ${formatAgo(h.at)}`
        })
        return [`${list.length} ${plural(list.length, ['indexer', 'indexers'])}:`, ...lines].join('\n')
      },
    }),
  ],
})
