import { z } from 'zod'
import { magnetInfoHash, torrentInfoHash } from '../bencode'
import { formatEta, formatSize, formatSpeed, plural, truncate } from '../format'
import { matchTorrents, shortHash } from '../torrents'
import { baseUrl, defineConnector, field, secret, toolFor, ToolError } from '../types'
import { TrClient, type TrTorrent } from './client'
import { t, tr, trc } from '../../i18n'

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Address on the local network', placeholder: 'http://transmission:9091' }),
    rpcPath: field(z.string().trim().startsWith('/', { error: () => t`The path starts with /` }).default('/transmission/rpc'), {
      label: 'RPC path',
      placeholder: '/transmission/rpc',
      mono: true,
      section: 'connection',
    }),
    authMode: field(z.enum(['none', 'basic']).default('none'), {
      label: 'Sign-in method',
      widget: 'segmented',
      section: 'connection',
      options: [
        {
          value: 'none',
          label: 'No authentication',
          short: 'No sign-in',
          help: 'rpc-authentication-required is off. In the Transmission settings.json add the hub\'s subnet to rpc-whitelist (or turn off rpc-whitelist-enabled).',
          showHubNetwork: true,
        },
        { value: 'basic', label: 'Username and password', short: 'Username', help: 'rpc-username and rpc-password from the Transmission settings.json.' },
      ],
    }),
    username: field(z.string().trim().optional(), { label: 'Username', section: 'connection', showWhen: { field: 'authMode', equals: ['basic'] } }),
    password: secret({ label: 'Password', section: 'connection', showWhen: { field: 'authMode', equals: ['basic'] } }),
    defaultLabel: field(z.string().trim().optional(), { label: 'Default label', placeholder: 'claude', help: 'Transmission 3.0+', section: 'defaults' }),
    downloadDir: field(z.string().trim().optional(), { label: 'Save folder', placeholder: '/downloads/claude', mono: true, section: 'defaults' }),
    addPaused: field(z.boolean().default(false), {
      label: 'Add torrents stopped',
      help: 'The assistant calls transmission_start itself',
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
const client = (c: Config) => new TrClient(c)

// Transmission status codes
const STATUS_LABELS: Record<number, string> = {
  0: 'stopped',
  1: 'waiting for check',
  2: 'checking',
  3: 'queued',
  4: 'downloading',
  5: 'queued for seeding',
  6: 'seeding',
}

type Row = TrTorrent & { hash: string }
const rows = (list: TrTorrent[]): Row[] => list.map((t) => ({ ...t, hash: t.hashString }))

function statusLabel(item: TrTorrent): string {
  if (item.error) return t`error: ${truncate(item.errorString, 60)}`
  if (item.status === 0 && item.percentDone >= 1) return t`done`
  return (STATUS_LABELS[item.status] ? tr(STATUS_LABELS[item.status]!) : String(item.status))
}

export function formatTransmissionLine(item: TrTorrent): string {
  const pct = Math.floor(item.percentDone * 100)
  const parts = [`${pct}%`]
  if (item.percentDone < 1 && item.rateDownload > 0) parts.push(`↓ ${formatSpeed(item.rateDownload)}`, t`${item.eta >= 0 ? formatEta(item.eta) : '∞'} left`)
  if (item.rateUpload > 0) parts.push(`↑ ${formatSpeed(item.rateUpload)}`)
  parts.push(t`peers ${item.peersSendingToUs}/${item.peersConnected}`, formatSize(item.totalSize), statusLabel(item))
  return `• ${truncate(item.name, 70)} — ${parts.join(' · ')} · hash ${shortHash(item.hashString)}`
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
  .describe('Torrent hashes from transmission_status (the first 8 characters are enough) or ["all"] for all')

async function resolveRefs(c: Config, refs: string[]): Promise<Row[] | 'all'> {
  if (refs.length === 1 && refs[0]!.toLowerCase() === 'all') return 'all'
  return matchTorrents(rows(await client(c).torrents()), refs, 'transmission_status')
}

function namesLine(targets: Row[] | 'all'): string {
  return targets === 'all' ? t`all torrents` : targets.map((t) => truncate(t.name, 50)).join(', ')
}

export const transmission = defineConnector<Config>({
  id: 'transmission',
  name: 'Transmission',
  description: 'Downloads to the user\'s device (Transmission)',
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
        details: [`RPC ${v.rpc}`, `${list.length} ${plural(list.length, ['torrent', 'torrents'])}`, t`response ${Date.now() - started} ms`],
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'transmission_status',
      title: 'Transmission download status',
      description: 'Torrents in Transmission: progress, speed, time left, peers, state and hash.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        filter: z.enum(['active', 'downloading', 'completed', 'stopped', 'errored', 'all']).default('active').describe('Which torrents to show'),
        label: z.string().optional().describe('Only with this label'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      async run({ filter, label, limit }, { config }) {
        const list = (await client(config).torrents())
          .filter(FILTERS[filter])
          .filter((t) => !label || (t.labels ?? []).includes(label))
          .sort((a, b) => b.addedDate - a.addedDate)
        if (list.length === 0) return t`No torrents (${trc('filter', FILTER_LABELS[filter])}).`
        const shown = list.slice(0, limit)
        const head = `${list.length} ${plural(list.length, ['torrent', 'torrents'])} (${trc('filter', FILTER_LABELS[filter])})${list.length > shown.length ? t`, showing ${shown.length}` : ''}:`
        return [head, ...shown.map(formatTransmissionLine)].join('\n')
      },
    }),

    tool({
      name: 'transmission_add',
      title: 'Add to Transmission',
      description: 'Add a torrent to Transmission. Preferably by result_id from search_torrents; a magnet link or a .torrent URL also works. Returns the hash.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        result_id: z.string().optional().describe('result_id from search_torrents'),
        url: z.string().optional().describe('A magnet link or an http(s) .torrent URL when there is no result_id'),
        label: z.string().optional().describe('Label; by default from the hub settings'),
        download_dir: z.string().optional().describe('Save folder; by default from the hub settings'),
        paused: z.boolean().optional().describe('Add stopped'),
      }),
      async run(args, { config, resolveResult }) {
        if (!args.result_id && !args.url) throw new ToolError(t`A result_id from search_torrents or a url is required`)
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
        if (added.duplicate) return t`Already in the list: ${truncate(added.name || title, 70)} · hash ${shortHash(added.hash)}`
        const extras = [label && t`label ${label}`, input.paused && t`stopped`, added.hash && `hash ${shortHash(added.hash)}`].filter(Boolean)
        return t`Added: ${truncate(title || added.name, 80)}${extras.length ? ` · ${extras.join(' · ')}` : ''}`
      },
    }),

    tool({
      name: 'transmission_stop',
      title: 'Stop in Transmission',
      description: 'Stop torrents in Transmission by hash, or all of them.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ hashes: hashesInput }),
      async run({ hashes }, { config }) {
        const targets = await resolveRefs(config, hashes)
        await client(config).stop(targets === 'all' ? 'all' : targets.map((t) => t.hashString))
        return t`Stopped: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'transmission_start',
      title: 'Start in Transmission',
      description: 'Start (resume) torrents in Transmission by hash, or all of them.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ hashes: hashesInput }),
      async run({ hashes }, { config }) {
        const targets = await resolveRefs(config, hashes)
        await client(config).start(targets === 'all' ? 'all' : targets.map((t) => t.hashString))
        return t`Started: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'transmission_delete',
      title: 'Delete from Transmission',
      description:
        'Delete torrents from Transmission. Files stay on disk by default. Deleting with files (delete_files: true) cannot be undone: ask the user first and pass confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        hashes: z.array(z.string().min(1)).min(1).describe('Torrent hashes from transmission_status'),
        delete_files: z.boolean().default(false).describe('Also delete the downloaded files from disk'),
        confirm: z.boolean().optional().describe('true — the user confirmed deleting with files'),
      }),
      async run({ hashes, delete_files, confirm }, { config }) {
        if (hashes.some((h) => h.toLowerCase() === 'all')) throw new ToolError(t`Deleting “all” is not allowed — list the hashes`)
        const targets = matchTorrents(rows(await client(config).torrents()), hashes, 'transmission_status')
        if (delete_files && confirm !== true) {
          return t`Not deleted. Deleting with files cannot be undone — ask the user and repeat with confirm: true.
To be deleted: ${namesLine(targets)}`
        }
        await client(config).remove(
          targets.map((t) => t.hashString),
          delete_files,
        )
        return t`Deleted${delete_files ? t` with files` : t` from the list (files stay on disk)`}: ${namesLine(targets)}`
      },
    }),

    tool({
      name: 'transmission_files',
      title: 'Torrent files in Transmission',
      description: 'Files inside a Transmission torrent with size and progress — for example, the episodes of a season.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ hash: z.string().min(1).describe('Torrent hash from transmission_status'), limit: z.number().int().min(1).max(100).default(40) }),
      async run({ hash, limit }, { config }) {
        const tr = client(config)
        const [item] = matchTorrents(rows(await tr.torrents()), [hash], 'transmission_status')
        const { files, wanted } = await tr.files(item!.hashString)
        const lines = files.slice(0, limit).map((f, i) => {
          const pct = f.length ? Math.floor((f.bytesCompleted / f.length) * 100) : 100
          return `• ${truncate(f.name.split('/').pop() ?? f.name, 70)} — ${pct}% · ${formatSize(f.length)}${wanted[i] === false ? t` · skipped` : ''}`
        })
        const more = files.length > limit ? t`
…and ${files.length - limit} more` : ''
        return `${truncate(item!.name, 70)} — ${files.length} ${plural(files.length, ['file', 'files'])}:\n${lines.join('\n')}${more}`
      },
    }),

    tool({
      name: 'transmission_info',
      title: 'Transmission speed and disk',
      description: 'Total Transmission download and upload speed, the number of active torrents and free space in the download folder.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const tr = client(config)
        const [s, free] = await Promise.all([tr.stats(), tr.freeSpace()])
        return [
          `↓ ${formatSpeed(s.downloadSpeed)} · ↑ ${formatSpeed(s.uploadSpeed)}`,
          t`Active: ${s.activeTorrentCount} of ${s.torrentCount}`,
          free !== null ? t`Free disk space: ${formatSize(free)}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),
  ],
})
