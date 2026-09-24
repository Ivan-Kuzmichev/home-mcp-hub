import { expectOk, serviceFetch } from '../http'
import { ToolError } from '../types'

export type JackettConfig = { baseUrl: string; apiKey: string }

export type JackettResult = {
  Tracker: string
  TrackerId: string
  Title: string
  Link: string | null
  MagnetUri: string | null
  InfoHash: string | null
  Size: number
  Seeders: number | null
  Peers: number | null
  PublishDate: string | null
  Category: number[]
}

export type Indexer = { id: string; name: string }

const SERVICE = 'Jackett'

export class JackettClient {
  constructor(private readonly cfg: JackettConfig) {}

  private url(path: string, params: Record<string, string | string[]> = {}): string {
    const q = new URLSearchParams({ apikey: this.cfg.apiKey })
    for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) q.append(k, x)
    return `${this.cfg.baseUrl}/api/v2.0/${path}?${q}`
  }

  /** Configured indexers via Torznab t=indexers (works with the API key alone). */
  async indexers(): Promise<Indexer[]> {
    const res = await serviceFetch(SERVICE, this.url('indexers/all/results/torznab/api', { t: 'indexers', configured: 'true' }))
    if (res.status === 401 || res.status === 403) throw new ToolError('Jackett: неверный API-ключ')
    await expectOk(SERVICE, res, 'список индексаторов')
    const xml = await res.text()
    if (/<error\b/.test(xml)) throw new ToolError(`Jackett: ${/description="([^"]+)"/.exec(xml)?.[1] ?? 'ошибка API'}`)
    return [...xml.matchAll(/<indexer\s+id="([^"]+)"[^>]*>\s*<title>([^<]*)<\/title>/g)].map((m) => ({ id: m[1]!, name: decodeXml(m[2]!) }))
  }

  async version(): Promise<string | null> {
    try {
      const res = await serviceFetch(SERVICE, `${this.cfg.baseUrl}/api/v2.0/server/config`, { timeoutMs: 5_000 })
      if (!res.ok) return null
      const data = (await res.json()) as { app_version?: string }
      return data.app_version ?? null
    } catch {
      return null
    }
  }

  async search(indexerId: string, query: string, categories: number[], signal: AbortSignal): Promise<JackettResult[]> {
    const params: Record<string, string | string[]> = { Query: query }
    if (categories.length) params['Category[]'] = categories.map(String)
    const res = await serviceFetch(SERVICE, this.url(`indexers/${encodeURIComponent(indexerId)}/results`, params), { signal, timeoutMs: 60_000 })
    await expectOk(SERVICE, res, `поиск (${indexerId})`)
    const data = (await res.json()) as { Results?: JackettResult[]; Indexers?: { Status?: number; Error?: string | null }[] }
    const err = data.Indexers?.find((i) => i.Error)?.Error
    if (err && !data.Results?.length) throw new Error(err)
    return data.Results ?? []
  }
}

function decodeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/** Jackett links carry the API key; the cache and Claude never see it. */
export function stripApiKey(link: string): string {
  try {
    const url = new URL(link)
    url.searchParams.delete('jackett_apikey')
    url.searchParams.delete('apikey')
    return url.toString()
  } catch {
    return link.replace(/([?&])(jackett_)?apikey=[^&]*&?/gi, '$1').replace(/[?&]$/, '')
  }
}
