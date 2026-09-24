import { expectOk, serviceFetch } from '../http'
import { ToolError } from '../types'

export type TsConfig = { baseUrl: string; authMode: 'none' | 'basic'; username?: string; password?: string }

export type TsFile = { id: number; path: string; length: number }

export type TsTorrent = {
  hash: string
  title: string
  poster?: string
  stat?: number
  stat_string?: string
  torrent_size?: number
  file_stats?: TsFile[]
}

const SERVICE = 'TorrServe'

export class TsClient {
  constructor(private readonly cfg: TsConfig) {}

  private headers(): Record<string, string> {
    if (this.cfg.authMode !== 'basic') return {}
    if (!this.cfg.username || !this.cfg.password) throw new ToolError(`${SERVICE}: не заданы логин и пароль`)
    return { Authorization: `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64')}` }
  }

  private async call(path: string, init: RequestInit, what: string): Promise<Response> {
    const res = await serviceFetch(SERVICE, `${this.cfg.baseUrl}${path}`, { ...init, headers: { ...this.headers(), ...(init.headers as Record<string, string>) } })
    return expectOk(SERVICE, res, what)
  }

  private async torrents<T>(body: Record<string, unknown>, what: string): Promise<T> {
    const res = await this.call('/torrents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, what)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  }

  async version(): Promise<string> {
    return (await (await this.call('/echo', {}, 'версия')).text()).trim()
  }

  add(input: { link: string; title?: string; poster?: string; saveToDb: boolean }): Promise<TsTorrent> {
    return this.torrents({ action: 'add', link: input.link, title: input.title ?? '', poster: input.poster ?? '', save_to_db: input.saveToDb }, 'добавление')
  }

  async upload(input: { data: Uint8Array; filename: string; title?: string; poster?: string; saveToDb: boolean }): Promise<TsTorrent> {
    const form = new FormData()
    form.set('file', new Blob([new Uint8Array(input.data)], { type: 'application/x-bittorrent' }), input.filename)
    if (input.title) form.set('title', input.title)
    if (input.poster) form.set('poster', input.poster)
    form.set('save', String(input.saveToDb))
    return (await (await this.call('/torrent/upload', { method: 'POST', body: form }, 'загрузка .torrent')).json()) as TsTorrent
  }

  async list(): Promise<TsTorrent[]> {
    return (await this.torrents<TsTorrent[] | null>({ action: 'list' }, 'список')) ?? []
  }

  get(hash: string): Promise<TsTorrent> {
    return this.torrents({ action: 'get', hash }, 'торрент')
  }

  async remove(hash: string): Promise<void> {
    await this.torrents({ action: 'rem', hash }, 'удаление')
  }
}
