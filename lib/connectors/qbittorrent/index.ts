import { z } from 'zod'
import { magnetInfoHash, torrentInfoHash } from '../bencode'
import { formatEta, formatSize, formatSpeed, plural, truncate } from '../format'
import { matchTorrents as matchShared, shortHash } from '../torrents'
import { baseUrl, defineConnector, field, secret, toolFor, ToolError } from '../types'
import { QbClient, type QbConfig, type QbTorrent } from './client'
import { t, tr, trc } from '../../i18n'

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Address on the local network', placeholder: 'http://qbittorrent:8080' }),
    authMode: field(z.enum(['none', 'apikey', 'password']).default('none'), {
      label: 'Sign-in method',
      widget: 'segmented',
      section: 'connection',
      options: [
        {
          value: 'none',
          label: 'No authentication',
          short: 'No sign-in',
          help: 'The hub calls qBittorrent without signing in. In qBittorrent: Settings → Web UI → “Bypass authentication for clients in whitelisted IP subnets” → add the subnet the hub comes from.',
          showHubNetwork: true,
        },
        { value: 'apikey', label: 'API key (5.2+)', short: 'API key', help: 'The key from Settings → Web UI → API key. Sent as Authorization: Bearer.' },
        { value: 'password', label: 'Username and password', short: 'Username', help: 'The qBittorrent Web UI username and password.' },
      ],
    }),
    apiKey: secret({ label: 'API key', section: 'connection', showWhen: { field: 'authMode', equals: ['apikey'] } }),
    username: field(z.string().trim().optional(), { label: 'Username', section: 'connection', showWhen: { field: 'authMode', equals: ['password'] } }),
    password: secret({ label: 'Password', section: 'connection', showWhen: { field: 'authMode', equals: ['password'] } }),
    defaultCategory: field(z.string().trim().optional(), { label: 'Default category', placeholder: 'claude', section: 'defaults' }),
    savePath: field(z.string().trim().optional(), { label: 'Save folder', placeholder: '/downloads/claude', mono: true, section: 'defaults' }),
    addStopped: field(z.boolean().default(false), {
      label: 'Add torrents stopped',
      help: 'The assistant calls torrent_start itself',
      widget: 'switch',
      section: 'defaults',
    }),
  })
  .superRefine((c, ctx) => {
    if (c.authMode === 'apikey' && !c.apiKey) ctx.addIssue({ code: 'custom', path: ['apiKey'], message: t`API key required` })
    if (c.authMode === 'password') {
      if (!c.username) ctx.addIssue({ code: 'custom', path: ['username'], message: t`Username required` })
      if (!c.password) ctx.addIssue({ code: 'custom', path: ['password'], message: t`Password required` })
    }
  })

type Config = z.output<typeof configSchema>

const client = (c: Config) => new QbClient(c satisfies QbConfig)
const tool = toolFor<Config>()

const STATE_LABELS: Record<string, string> = {
  downloading: 'downloading',
  forcedDL: 'downloading',
  metaDL: 'fetching metadata',
  forcedMetaDL: 'fetching metadata',
  stalledDL: 'waiting for peers',
  uploading: 'seeding',
  forcedUP: 'seeding',
  stalledUP: 'done, seeding',
  stoppedDL: 'stopped',
  stoppedUP: 'done',
  queuedDL: 'queued',
  queuedUP: 'queued for seeding',
  checkingDL: 'checking',
  checkingUP: 'checking',
  checkingResumeData: 'checking',
  moving: 'moving',
  error: 'error',
  missingFiles: 'missing files',
}

export function formatTorrentLine(item: QbTorrent): string {
  const pct = Math.floor(item.progress * 100)
  const parts = [`${pct}%`]
  if (item.progress < 1 && item.dlspeed > 0) parts.push(`↓ ${formatSpeed(item.dlspeed)}`, t`${formatEta(item.eta)} left`)
  if (item.upspeed > 0) parts.push(`↑ ${formatSpeed(item.upspeed)}`)
  parts.push(t`seeds ${item.num_seeds}/${item.num_complete}`, formatSize(item.size), (STATE_LABELS[item.state] ? tr(STATE_LABELS[item.state]!) : item.state))
  return `• ${truncate(item.name, 70)} — ${parts.join(' · ')} · hash ${shortHash(item.hash)}`
}

export function matchTorrents(all: QbTorrent[], refs: string[]): QbTorrent[] {
  return matchShared(all, refs, 'torrents_status')
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
  active: 'active',
  downloading: 'downloading',
  completed: 'completed',
  stopped: 'stopped',
  errored: 'errored',
  all: 'all',
}

const hashesInput = z
  .array(z.string().min(1))
  .min(1)
  .describe('Torrent hashes from torrents_status (the first 8 characters are enough) or ["all"] for all')

async function resolveRefs(c: Config, refs: string[]): Promise<{ targets: QbTorrent[] | 'all' }> {
  if (refs.length === 1 && refs[0]!.toLowerCase() === 'all') return { targets: 'all' }
  return { targets: matchTorrents(await client(c).torrents(), refs) }
}

function namesLine(targets: QbTorrent[] | 'all'): string {
  if (targets === 'all') return t`all torrents`
  return targets.map((t) => truncate(t.name, 50)).join(', ')
}

export const qbittorrent = defineConnector<Config>({
  id: 'qbittorrent',
  name: 'qBittorrent',
  description: 'Downloads to the user\'s device',
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
        details: [`WebAPI ${api}`, `${torrents.length} ${plural(torrents.length, ['torrent', 'torrents'])}`, t`response ${Date.now() - started} ms`],
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'torrents_status',
      title: 'Download status',
      description: 'Torrents in qBittorrent: progress, speed, time left, seeds, state and hash.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        filter: z.enum(['active', 'downloading', 'completed', 'stopped', 'errored', 'all']).default('active').describe('Which torrents to show'),
        category: z.string().optional().describe('Only this category'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      async run({ filter, category, limit }, { config }) {
        const list = await client(config).torrents({ filter: FILTERS[filter], category, sort: 'added_on', reverse: true })
        const label = trc('filter', FILTER_LABELS[filter])
        if (list.length === 0) return t`No torrents (${label}).`
        const shown = list.slice(0, limit)
        const head = `${list.length} ${plural(list.length, ['torrent', 'torrents'])} (${label})${list.length > shown.length ? t`, showing ${shown.length}` : ''}:`
        return [head, ...shown.map(formatTorrentLine)].join('\n')
      },
    }),

    tool({
      name: 'torrent_add',
      title: 'Add download',
      description:
        'Add a torrent to qBittorrent. Preferably by result_id from search_torrents; a magnet link or a .torrent URL also works. Returns the hash.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        result_id: z.string().optional().describe('result_id from search_torrents'),
        url: z.string().optional().describe('A magnet link or an http(s) .torrent URL when there is no result_id'),
        category: z.string().optional().describe('Category; by default from the hub settings'),
        save_path: z.string().optional().describe('Save folder; by default from the hub settings'),
        stopped: z.boolean().optional().describe('Add stopped'),
      }),
      async run(args, { config, resolveResult }) {
        const { result_id, url } = args
        if (!result_id && !url) throw new ToolError(t`A result_id from search_torrents or a url is required`)
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
          if (existing[0]) return t`Already in the list: ${truncate(existing[0].name, 70)} · ${Math.floor(existing[0].progress * 100)}% · hash ${shortHash(hash)}`
        }

        await qb.add({ ...payload, category, savePath, stopped })
        const extras = [category && t`category ${category}`, stopped && t`stopped`, hash && `hash ${shortHash(hash)}`].filter(Boolean)
        return t`Added: ${truncate(title, 80)}${extras.length ? ` · ${extras.join(' · ')}` : ''}`
      },
    }),

    tool({
      name: 'torrent_stop',
      title: 'Stop download',
      description: 'Stop torrents by hash, or all of them.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ hashes: hashesInput }),
      async run({ hashes }, { config }) {
        const { targets } = await resolveRefs(config, hashes)
        await client(config).stop(targets === 'all' ? 'all' : targets.map((t) => t.hash))
        return t`Stopped: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'torrent_start',
      title: 'Start download',
      description: 'Start (resume) torrents by hash, or all of them.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ hashes: hashesInput }),
      async run({ hashes }, { config }) {
        const { targets } = await resolveRefs(config, hashes)
        await client(config).start(targets === 'all' ? 'all' : targets.map((t) => t.hash))
        return t`Started: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'torrent_delete',
      title: 'Delete torrent',
      description:
        'Delete torrents from qBittorrent. Files stay on disk by default. Deleting with files (delete_files: true) cannot be undone: ask the user first and pass confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        hashes: z.array(z.string().min(1)).min(1).describe('Torrent hashes from torrents_status'),
        delete_files: z.boolean().default(false).describe('Also delete the downloaded files from disk'),
        confirm: z.boolean().optional().describe('true — the user confirmed deleting with files'),
      }),
      async run({ hashes, delete_files, confirm }, { config }) {
        const refs = hashes
        if (refs.some((h) => h.toLowerCase() === 'all')) throw new ToolError(t`Deleting “all” is not allowed — list the hashes`)
        const targets = matchTorrents(await client(config).torrents(), refs)
        if (delete_files && confirm !== true) {
          return t`Not deleted. Deleting with files cannot be undone — ask the user and repeat with confirm: true.
To be deleted: ${namesLine(targets)}`
        }
        await client(config).delete(
          targets.map((t) => t.hash),
          delete_files,
        )
        return t`Deleted${delete_files ? t` with files` : t` from the list (files stay on disk)`}: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'torrent_files',
      title: 'Torrent files',
      description: 'Files inside a torrent with size and progress — for example, the episodes of a season.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ hash: z.string().min(1).describe('Torrent hash from torrents_status'), limit: z.number().int().min(1).max(100).default(40) }),
      async run({ hash, limit }, { config }) {
        const qb = client(config)
        const [item] = matchTorrents(await qb.torrents(), [hash])
        const files = await qb.files(item!.hash)
        const shown = files.slice(0, limit)
        const lines = shown.map((f) => {
          const skip = f.priority === 0 ? t` · skipped` : ''
          return `• ${truncate(f.name.split('/').pop() ?? f.name, 70)} — ${Math.floor(f.progress * 100)}% · ${formatSize(f.size)}${skip}`
        })
        const more = files.length > shown.length ? t`
…and ${files.length - shown.length} more` : ''
        return `${truncate(item!.name, 70)} — ${files.length} ${plural(files.length, ['file', 'files'])}:\n${lines.join('\n')}${more}`
      },
    }),

    tool({
      name: 'transfer_info',
      title: 'Speed and disk',
      description: 'Total download and upload speed, connection state and free disk space.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const qb = client(config)
        const [info, free] = await Promise.all([qb.transferInfo(), qb.freeSpace().catch(() => null)])
        const conn: Record<string, string> = { connected: t`connected`, firewalled: t`behind a firewall`, disconnected: t`disconnected` }
        return [
          `↓ ${formatSpeed(info.dl_info_speed)} · ↑ ${formatSpeed(info.up_info_speed)}`,
          t`Connection: ${conn[info.connection_status] ?? info.connection_status} · DHT ${info.dht_nodes} nodes`,
          free !== null ? t`Free disk space: ${formatSize(free)}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),
  ],
})
