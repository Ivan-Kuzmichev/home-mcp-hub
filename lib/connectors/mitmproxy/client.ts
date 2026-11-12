import { randomBytes } from 'node:crypto'
import { scrub, serviceFetch } from '../http'
import { ToolError } from '../types'
import { t } from '../../i18n'

export type MitmConfig = { baseUrl: string; password?: string; timeoutSec: number }

export type MitmFlow = {
  id: string
  type: string
  comment: string
  timestamp_created: number
  client_conn?: { peername?: [string, number] }
  // pretty_host: the Host / :authority name; `host` is the IP in transparent, WireGuard and SOCKS5-with-IP modes.
  request?: { method: string; scheme: string; host: string; pretty_host?: string; port: number; path: string; headers: [string, string][]; contentLength: number | null; timestamp_start: number }
  response?: { status_code: number; headers: [string, string][]; contentLength: number | null }
  error?: { msg: string }
}

const SERVICE = 'mitmproxy'
const XSRF_COOKIE = '_mitmproxy_xsrf'

export class MitmClient {
  // Tornado accepts any plain hex token as long as cookie and header match.
  private readonly xsrf = randomBytes(16).toString('hex')

  constructor(private readonly cfg: MitmConfig) {}

  private async call(method: string, path: string, opts: { body?: unknown; flow?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = {}
    if (this.cfg.password) headers.Authorization = `Bearer ${this.cfg.password}`
    if (method !== 'GET') {
      headers.Cookie = `${XSRF_COOKIE}=${this.xsrf}`
      headers['X-XSRFToken'] = this.xsrf
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

    let res: Response
    try {
      res = await serviceFetch(SERVICE, `${this.cfg.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        timeoutMs: this.cfg.timeoutSec * 1000,
      })
    } catch (e) {
      if (e instanceof ToolError) throw new ToolError(t`${e.message} — check the mitmweb container and the address in the settings`)
      throw e
    }
    if (res.ok) return res

    if (res.status === 403) throw new ToolError(t`mitmproxy: wrong web interface password (403)`)
    if (res.status === 404 && opts.flow) throw new ToolError(t`The request is no longer in mitmproxy — it keeps only the latest requests`)
    throw new ToolError(t`mitmproxy: error ${res.status} (${res.statusText || t`no description`})`)
  }

  private async json<T>(path: string): Promise<T> {
    return (await (await this.call('GET', path)).json()) as T
  }

  async state(): Promise<{ version: string; modes: string[] }> {
    const s = await this.json<{ version?: string; servers?: unknown }>('/state')
    const servers: unknown[] = Array.isArray(s.servers) ? s.servers : []
    const modes = servers.flatMap((x) => {
      const o = (x ?? {}) as { full_spec?: unknown; type?: unknown }
      const m = typeof o.full_spec === 'string' ? o.full_spec : typeof o.type === 'string' ? o.type : undefined
      return m ? [scrub(m)] : []
    })
    return { version: s.version ?? '?', modes }
  }

  flows(): Promise<MitmFlow[]> {
    return this.json('/flows')
  }

  async content(id: string, part: 'request' | 'response'): Promise<Buffer> {
    const res = await this.call('GET', `/flows/${encodeURIComponent(id)}/${part}/content.data`, { flow: true })
    return Buffer.from(await res.arrayBuffer())
  }

  options(): Promise<Record<string, { value: unknown }>> {
    return this.json('/options')
  }

  async setOptions(update: Record<string, unknown>): Promise<void> {
    await this.call('PUT', '/options', { body: update })
  }

  async clear(): Promise<void> {
    await this.call('POST', '/clear')
  }
}
