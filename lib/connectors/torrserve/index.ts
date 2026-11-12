import { z } from 'zod'
import { formatSize, plural, truncate } from '../format'
import { baseUrl, defineConnector, field, secret, toolFor, ToolError } from '../types'
import { TsClient, type TsFile, type TsTorrent } from './client'
import { t } from '../../i18n'

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Address for the hub', placeholder: 'http://torrserve:8090', help: 'The hub calls the API at this address — usually the container name' }),
    streamUrl: field(
      z
        .string()
        .trim()
        .url({ error: () => t`Needs an address like http://192.168.1.10:8090` })
        .transform((v) => v.replace(/\/+$/, ''))
        .optional(),
      {
        label: 'Address for players',
        placeholder: 'http://192.168.1.10:8090',
        help: 'The home address of TorrServe for stream links (TV, VLC). Empty — same as the address for the hub',
        widget: 'url',
        mono: true,
        section: 'connection',
      },
    ),
    authMode: field(z.enum(['none', 'basic']).default('none'), {
      label: 'Sign-in method',
      widget: 'segmented',
      section: 'connection',
      options: [
        { value: 'none', label: 'No authentication', short: 'No sign-in', help: 'By default TorrServe runs without a password.' },
        { value: 'basic', label: 'Username and password', short: 'Username', help: 'If TorrServe runs with --httpauth: the username and password from accs.db.' },
      ],
    }),
    username: field(z.string().trim().optional(), { label: 'Username', section: 'connection', showWhen: { field: 'authMode', equals: ['basic'] } }),
    password: secret({ label: 'Password', section: 'connection', showWhen: { field: 'authMode', equals: ['basic'] } }),
    saveToDb: field(z.boolean().default(true), {
      label: 'Save to the TorrServe database',
      help: 'The torrent stays in the list after a restart',
      widget: 'switch',
      section: 'defaults',
    }),
  })
  .superRefine((c, ctx) => {
    if (c.authMode === 'basic') {
      if (!c.username) ctx.addIssue({ code: 'custom', path: ['username'], message: t`Username required` })
      if (!c.password) ctx.addIssue({ code: 'custom', path: ['password'], message: t`Password required` })
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
  if (matches.length === 0) throw new ToolError(t`TorrServe has no “${ref}” — check torrserve_list`)
  throw new ToolError(t`“${ref}” matches several:
${matches.slice(0, 5).map((t) => `• ${truncate(t.title, 60)} · hash ${short(t.hash)}`).join('\n')}`)
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
  description: 'Torrent streaming',
  docsUrl: 'https://github.com/YouROK/TorrServer',
  configSchema,

  instructions(_c, { tools }) {
    const parts = [tools.includes('torrserve_add') ? t`watch without downloading — torrserve_add` : null, tools.includes('torrserve_links') ? t`player links — torrserve_links` : null].filter(Boolean)
    return parts.length ? `TorrServe: ${parts.join(', ')}.` : null
  },

  async test(c) {
    const started = Date.now()
    try {
      const ts = client(c)
      const [version, list] = await Promise.all([ts.version(), ts.list()])
      return {
        ok: true,
        version,
        summary: `TorrServe ${version}`,
        details: [t`${list.length} in the database`, t`response ${Date.now() - started} ms`],
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'torrserve_add',
      title: 'Add to TorrServe',
      description: 'Add a torrent to TorrServe to watch without downloading. Preferably by result_id from search_torrents. Then torrserve_links gives the player links.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        result_id: z.string().optional().describe('result_id from search_torrents'),
        url: z.string().optional().describe('A magnet link or a hash when there is no result_id'),
        title: z.string().optional().describe('Title for the TorrServe list'),
        poster: z.string().url().optional().describe('Poster URL'),
      }),
      async run(args, { config, resolveResult }) {
        if (!args.result_id && !args.url) throw new ToolError(t`A result_id from search_torrents or a url is required`)
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
        if (!added?.hash) throw new ToolError(t`TorrServe returned no hash — check the link`)
        return t`Added to TorrServe: ${truncate(added.title || args.title || '', 80)} · hash ${short(added.hash)}
Player links — torrserve_links.`
      },
    }),

    tool({
      name: 'torrserve_list',
      title: 'TorrServe list',
      description: 'What is already in TorrServe: title, size, state, hash.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      async run({ limit }, { config }) {
        const list = await client(config).list()
        if (list.length === 0) return t`TorrServe is empty.`
        const lines = list.slice(0, limit).map((t) => {
          const parts = [t.torrent_size ? formatSize(t.torrent_size) : null, t.stat_string, `hash ${short(t.hash)}`].filter(Boolean)
          return `• ${truncate(t.title, 70)} — ${parts.join(' · ')}`
        })
        return [t`TorrServe has ${list.length} ${plural(list.length, ['torrent', 'torrents'])}:`, ...lines].join('\n')
      },
    }),

    tool({
      name: 'torrserve_links',
      title: 'Stream links',
      description: 'An M3U playlist link and direct links to the video files of a torrent in TorrServe. They work on the home network or over VPN.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        hash: z.string().min(1).describe('Hash from torrserve_list or torrserve_add (8 characters are enough)'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      async run({ hash, limit }, { config }) {
        const ts = client(config)
        const item = match(await ts.list(), hash)
        const full = await ts.get(item.hash)
        const links = streamLinks(config, { ...item, ...full, title: full.title || item.title })
        const lines = [`${truncate(full.title || item.title, 70)}`, t`Playlist: ${links.playlist}`]
        if (links.files.length === 0) {
          lines.push(full.file_stats?.length ? t`No video files.` : t`The files are not known yet — TorrServe is fetching metadata, try again in a minute.`)
        } else {
          lines.push(...links.files.slice(0, limit).map(({ file, url }) => `• ${truncate(file.path.split('/').pop() ?? '', 60)} (${formatSize(file.length)}): ${url}`))
          if (links.files.length > limit) lines.push(t`…and ${links.files.length - limit} more — they are in the playlist`)
        }
        if (config.authMode === 'basic') lines.push(t`TorrServe has a password: the player will ask for a username.`)
        return lines.join('\n')
      },
    }),

    tool({
      name: 'torrserve_remove',
      title: 'Remove from TorrServe',
      description: 'Remove a torrent from the TorrServe database. Files on disk are not affected — TorrServe keeps only a cache.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ hash: z.string().min(1).describe('Hash from torrserve_list') }),
      async run({ hash }, { config }) {
        const ts = client(config)
        const item = match(await ts.list(), hash)
        await ts.remove(item.hash)
        return t`Removed from TorrServe: ${truncate(item.title, 70)}`
      },
    }),
  ],
})
