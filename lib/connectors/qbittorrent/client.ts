import { expectOk, serviceFetch } from '../http'
import { ToolError } from '../types'

export type QbAuthMode = 'none' | 'apikey' | 'password'

export type QbConfig = {
  baseUrl: string
  authMode: QbAuthMode
  apiKey?: string
  username?: string
  password?: string
}

export type QbTorrent = {
  hash: string
  name: string
  state: string
  progress: number
  dlspeed: number
  upspeed: number
  eta: number
  num_seeds: number
  num_complete: number
  size: number
  category: string
  added_on: number
  save_path?: string
}

export type QbFile = { index: number; name: string; size: number; progress: number; priority: number }

export type QbTransferInfo = {
  dl_info_speed: number
  up_info_speed: number
  connection_status: string
  dht_nodes: number
}

const SERVICE = 'qBittorrent'

// Session cookie per instance. The promise is shared so parallel requests log in once;
// on 403 only the request holding the stale session triggers a new login.
const sessions = new Map<string, Promise<string>>()

function sessionKey(cfg: QbConfig): string {
  return `${cfg.baseUrl}|${cfg.username ?? ''}`
}

/** qBittorrent 5.2 names the cookie QBT_SID_<port>; older versions use SID. Take whatever it sets. */
export function pickSessionCookie(setCookies: string[]): string | null {
  const pairs = setCookies.map((c) => c.split(';')[0]?.trim() ?? '').filter((p) => p.includes('='))
  return pairs.find((p) => /^(QBT_SID_\d+|SID)=/.test(p)) ?? pairs[0] ?? null
}

export class QbClient {
  constructor(private readonly cfg: QbConfig) {}

  private url(path: string): string {
    return `${this.cfg.baseUrl}/api/v2/${path}`
  }

  private async login(): Promise<string> {
    const { username, password, baseUrl } = this.cfg
    if (!username || !password) throw new ToolError(`${SERVICE}: не заданы логин и пароль`)
    const res = await serviceFetch(SERVICE, this.url('auth/login'), {
      method: 'POST',
      // Referer (or Origin) is mandatory, otherwise qBittorrent answers 401.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: baseUrl, Origin: baseUrl },
      body: new URLSearchParams({ username, password }),
    })
    if (res.status === 403) throw new ToolError(`${SERVICE}: IP хаба забанен за неудачные входы — подожди или сними бан в настройках`)
    const text = await res.text()
    if (!res.ok || text.trim() === 'Fails.') throw new ToolError(`${SERVICE}: неверный логин или пароль`)
    const cookie = pickSessionCookie(res.headers.getSetCookie())
    if (!cookie) throw new ToolError(`${SERVICE}: вход без cookie сессии — проверь версию qBittorrent`)
    return cookie
  }

  private session(): Promise<string> {
    const key = sessionKey(this.cfg)
    let s = sessions.get(key)
    if (!s) {
      s = this.login()
      sessions.set(key, s)
      // A failed login must not stay cached.
      s.catch(() => sessions.get(key) === s && sessions.delete(key))
    }
    return s
  }

  private async authHeaders(): Promise<Record<string, string>> {
    switch (this.cfg.authMode) {
      case 'none':
        return {}
      case 'apikey':
        if (!this.cfg.apiKey) throw new ToolError(`${SERVICE}: не задан API-ключ`)
        return { Authorization: `Bearer ${this.cfg.apiKey}` }
      case 'password':
        return { Cookie: await this.session(), Referer: this.cfg.baseUrl }
    }
  }

  async request(path: string, init: RequestInit = {}, what = path): Promise<Response> {
    const key = sessionKey(this.cfg)
    let used: Promise<string> | undefined
    const send = async () => {
      const auth = await this.authHeaders()
      used = sessions.get(key)
      return serviceFetch(SERVICE, this.url(path), { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } })
    }
    let res = await send()
    if (res.status === 403 && this.cfg.authMode === 'password') {
      // Drop the session only if nobody has replaced it with a fresh one meanwhile.
      if (sessions.get(key) === used) sessions.delete(key)
      res = await send()
    }
    return expectOk(SERVICE, res, what)
  }

  private async json<T>(path: string, what: string): Promise<T> {
    return (await (await this.request(path, {}, what)).json()) as T
  }

  private form(path: string, params: Record<string, string>, what: string): Promise<Response> {
    return this.request(path, { method: 'POST', body: new URLSearchParams(params) }, what)
  }

  async version(): Promise<string> {
    return (await (await this.request('app/version', {}, 'версия')).text()).trim()
  }

  async webapiVersion(): Promise<string> {
    return (await (await this.request('app/webapiVersion', {}, 'версия API')).text()).trim()
  }

  torrents(params: { filter?: string; category?: string; hashes?: string[]; sort?: string; reverse?: boolean } = {}): Promise<QbTorrent[]> {
    const q = new URLSearchParams()
    if (params.filter) q.set('filter', params.filter)
    if (params.category !== undefined) q.set('category', params.category)
    if (params.hashes?.length) q.set('hashes', params.hashes.join('|'))
    if (params.sort) q.set('sort', params.sort)
    if (params.reverse) q.set('reverse', 'true')
    return this.json(`torrents/info?${q}`, 'список торрентов')
  }

  async add(input: {
    urls?: string
    file?: { data: Uint8Array; filename: string }
    category?: string
    savePath?: string
    stopped?: boolean
  }): Promise<void> {
    const form = new FormData()
    if (input.urls) form.set('urls', input.urls)
    if (input.file) form.set('torrents', new Blob([new Uint8Array(input.file.data)], { type: 'application/x-bittorrent' }), input.file.filename)
    if (input.category) form.set('category', input.category)
    if (input.savePath) form.set('savepath', input.savePath)
    // qBittorrent 5.x: `stopped`, not `paused`.
    if (input.stopped !== undefined) form.set('stopped', String(input.stopped))
    const res = await this.request('torrents/add', { method: 'POST', body: form }, 'добавление')
    const text = (await res.text()).trim()
    if (text === 'Fails.') throw new ToolError(`${SERVICE} не принял торрент: он уже в списке или ссылка битая`)
  }

  // 5.x renamed pause/resume to stop/start; the old endpoints answer 404.
  async stop(hashes: string[] | 'all'): Promise<void> {
    await this.form('torrents/stop', { hashes: hashes === 'all' ? 'all' : hashes.join('|') }, 'остановка')
  }

  async start(hashes: string[] | 'all'): Promise<void> {
    await this.form('torrents/start', { hashes: hashes === 'all' ? 'all' : hashes.join('|') }, 'запуск')
  }

  async delete(hashes: string[], deleteFiles: boolean): Promise<void> {
    await this.form('torrents/delete', { hashes: hashes.join('|'), deleteFiles: String(deleteFiles) }, 'удаление')
  }

  files(hash: string): Promise<QbFile[]> {
    return this.json(`torrents/files?hash=${encodeURIComponent(hash)}`, 'файлы торрента')
  }

  transferInfo(): Promise<QbTransferInfo> {
    return this.json('transfer/info', 'статистика')
  }

  async freeSpace(): Promise<number | null> {
    const data = await this.json<{ server_state?: { free_space_on_disk?: number } }>('sync/maindata', 'состояние')
    return data.server_state?.free_space_on_disk ?? null
  }
}
