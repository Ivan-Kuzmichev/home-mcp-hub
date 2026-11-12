import { expectOk, serviceFetch } from '../http'
import { ToolError } from '../types'
import { t } from '../../i18n'

export type TrConfig = { baseUrl: string; rpcPath: string; authMode: 'none' | 'basic'; username?: string; password?: string }

export type TrTorrent = {
  id: number
  hashString: string
  name: string
  status: number
  percentDone: number
  rateDownload: number
  rateUpload: number
  eta: number
  peersSendingToUs: number
  peersConnected: number
  totalSize: number
  error: number
  errorString: string
  labels?: string[]
  addedDate: number
}

export type TrFile = { name: string; length: number; bytesCompleted: number }

export const TORRENT_FIELDS = [
  'id', 'hashString', 'name', 'status', 'percentDone', 'rateDownload', 'rateUpload', 'eta',
  'peersSendingToUs', 'peersConnected', 'totalSize', 'error', 'errorString', 'labels', 'addedDate',
]

const SERVICE = 'Transmission'

// X-Transmission-Session-Id per instance: CSRF token handed out with a 409.
const sessionIds = new Map<string, string>()

export class TrClient {
  constructor(private readonly cfg: TrConfig) {}

  private get url(): string {
    return `${this.cfg.baseUrl}${this.cfg.rpcPath}`
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    const sid = sessionIds.get(this.url)
    if (sid) h['X-Transmission-Session-Id'] = sid
    if (this.cfg.authMode === 'basic') {
      if (!this.cfg.username || !this.cfg.password) throw new ToolError(t`${SERVICE}: username and password are not set`)
      h.Authorization = `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64')}`
    }
    return h
  }

  async rpc<T>(method: string, args: Record<string, unknown> = {}, what = method): Promise<T> {
    const send = () => serviceFetch(SERVICE, this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify({ method, arguments: args }) })
    let res = await send()
    // First call (or a restarted daemon): 409 carries the session id to repeat.
    if (res.status === 409) {
      const sid = res.headers.get('x-transmission-session-id')
      if (!sid) throw new ToolError(t`${SERVICE}: 409 without X-Transmission-Session-Id — is this really Transmission RPC?`)
      sessionIds.set(this.url, sid)
      res = await send()
    }
    if (res.status === 401) throw new ToolError(t`${SERVICE}: wrong username or password`)
    if (res.status === 403) throw new ToolError(t`${SERVICE}: access denied — add the hub's IP to rpc-whitelist`)
    await expectOk(SERVICE, res, what)
    const data = (await res.json()) as { result: string; arguments?: T }
    if (data.result !== 'success') throw new ToolError(`${SERVICE}: ${what} — ${data.result}`)
    return (data.arguments ?? {}) as T
  }

  async version(): Promise<{ version: string; rpc: number }> {
    const s = await this.rpc<{ version: string; 'rpc-version': number }>('session-get', { fields: ['version', 'rpc-version'] }, t`version`)
    return { version: s.version, rpc: s['rpc-version'] }
  }

  async torrents(ids?: (number | string)[]): Promise<TrTorrent[]> {
    const r = await this.rpc<{ torrents: TrTorrent[] }>('torrent-get', { fields: TORRENT_FIELDS, ...(ids ? { ids } : {}) }, t`torrent list`)
    return r.torrents
  }

  async files(hash: string): Promise<{ name: string; files: TrFile[]; wanted: boolean[] }> {
    const r = await this.rpc<{ torrents: { name: string; files: TrFile[]; wanted: (boolean | number)[] }[] }>(
      'torrent-get',
      { ids: [hash], fields: ['name', 'files', 'wanted'] },
      t`torrent files`,
    )
    const item = r.torrents[0]
    if (!item) throw new ToolError(t`${SERVICE}: torrent not found`)
    return { name: item.name, files: item.files, wanted: item.wanted.map(Boolean) }
  }

  /** Returns the hash and whether it was already there (torrent-duplicate). */
  async add(input: { magnetOrUrl?: string; metainfo?: Uint8Array; downloadDir?: string; paused?: boolean; labels?: string[] }): Promise<{ hash: string; name: string; duplicate: boolean }> {
    const args: Record<string, unknown> = {}
    if (input.magnetOrUrl) args.filename = input.magnetOrUrl
    if (input.metainfo) args.metainfo = Buffer.from(input.metainfo).toString('base64')
    if (input.downloadDir) args['download-dir'] = input.downloadDir
    if (input.paused !== undefined) args.paused = input.paused
    if (input.labels?.length) args.labels = input.labels
    const r = await this.rpc<{ 'torrent-added'?: { hashString: string; name: string }; 'torrent-duplicate'?: { hashString: string; name: string } }>('torrent-add', args, t`adding`)
    const item = r['torrent-added'] ?? r['torrent-duplicate']
    if (!item) throw new ToolError(t`${SERVICE} did not accept the torrent`)
    return { hash: item.hashString, name: item.name, duplicate: !r['torrent-added'] }
  }

  async stop(ids: string[] | 'all'): Promise<void> {
    await this.rpc('torrent-stop', ids === 'all' ? {} : { ids }, t`stopping`)
  }

  async start(ids: string[] | 'all'): Promise<void> {
    await this.rpc('torrent-start', ids === 'all' ? {} : { ids }, t`starting`)
  }

  async remove(ids: string[], deleteLocalData: boolean): Promise<void> {
    await this.rpc('torrent-remove', { ids, 'delete-local-data': deleteLocalData }, t`deleting`)
  }

  async stats(): Promise<{ downloadSpeed: number; uploadSpeed: number; activeTorrentCount: number; torrentCount: number }> {
    return this.rpc('session-stats', {}, t`statistics`)
  }

  async freeSpace(): Promise<number | null> {
    try {
      const s = await this.rpc<{ 'download-dir': string }>('session-get', { fields: ['download-dir'] })
      const f = await this.rpc<{ 'size-bytes': number }>('free-space', { path: s['download-dir'] })
      return f['size-bytes']
    } catch {
      return null
    }
  }
}
