import { expectOk, serviceFetch } from '../http'
import { ToolError } from '../types'

export type PlConfig = { baseUrl: string; apiToken?: string }

export type PlDocument = {
  id: number
  title: string
  content?: string
  created: string
  added: string
  correspondent: number | null
  document_type: number | null
  tags: number[]
  archive_serial_number?: number | null
  original_file_name?: string | null
  __search_hit__?: { score?: number; highlights?: string; rank?: number }
}

export type PlNamed = { id: number; name: string; document_count?: number; is_inbox_tag?: boolean }

export type PlSuggestions = { correspondents: number[]; tags: number[]; document_types: number[]; dates: string[] }

export type Taxonomy = { tags: PlNamed[]; correspondents: PlNamed[]; documentTypes: PlNamed[] }

export type PlKind = 'tags' | 'correspondents' | 'document_types'

const SERVICE = 'Paperless'

export class PlClient {
  constructor(private readonly cfg: PlConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    if (!this.cfg.apiToken) throw new ToolError(`${SERVICE}: не задан API-токен`)
    return { Authorization: `Token ${this.cfg.apiToken}`, Accept: 'application/json', ...extra }
  }

  private url(path: string, params?: Record<string, string | number | undefined>): string {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') q.set(k, String(v))
    const qs = q.toString()
    return `${this.cfg.baseUrl}/api/${path}${qs ? `?${qs}` : ''}`
  }

  private async send(path: string, init: RequestInit & { params?: Record<string, string | number | undefined> } = {}, what = path): Promise<Response> {
    const { params, ...rest } = init
    const res = await serviceFetch(SERVICE, this.url(path, params), { ...rest, headers: this.headers(rest.headers as Record<string, string>) })
    if (res.status === 401) throw new ToolError(`${SERVICE}: неверный API-токен`)
    if (res.status === 403) throw new ToolError(`${SERVICE}: у пользователя токена нет прав на это действие`)
    if (res.status === 404) throw new ToolError(`${SERVICE}: не найдено (${what})`)
    return expectOk(SERVICE, res, what)
  }

  private async json<T>(path: string, params?: Record<string, string | number | undefined>, what = path): Promise<T> {
    return (await (await this.send(path, { params }, what)).json()) as T
  }

  /** Server version from the X-Version header (paperless-ngx sets it on API responses). */
  async ping(): Promise<{ version: string | null; documents: number }> {
    const res = await this.send('documents/', { params: { page_size: 1 } }, 'список документов')
    const data = (await res.json()) as { count: number }
    return { version: res.headers.get('x-version'), documents: data.count }
  }

  async documents(params: Record<string, string | number | undefined>): Promise<{ count: number; results: PlDocument[] }> {
    return this.json('documents/', params, 'поиск документов')
  }

  document(id: number): Promise<PlDocument> {
    return this.json(`documents/${id}/`, undefined, `документ ${id}`)
  }

  async suggestions(id: number): Promise<PlSuggestions | null> {
    try {
      const s = await this.json<Partial<PlSuggestions>>(`documents/${id}/suggestions/`, undefined, 'подсказки')
      return { correspondents: s.correspondents ?? [], tags: s.tags ?? [], document_types: s.document_types ?? [], dates: s.dates ?? [] }
    } catch {
      // The classifier may not be trained yet; suggestions are a bonus.
      return null
    }
  }

  async thumbnail(id: number): Promise<{ data: Buffer; mimeType: string }> {
    const res = await this.send(`documents/${id}/thumb/`, {}, 'превью')
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type')?.split(';')[0] ?? 'image/webp' }
  }

  /** Streams the archived PDF (default) or the original file. */
  download(id: number, original: boolean): Promise<Response> {
    return this.send(`documents/${id}/download/`, { params: original ? { original: 'true' } : undefined }, 'скачивание')
  }

  async update(id: number, patch: Record<string, unknown>): Promise<PlDocument> {
    const body = (p: Record<string, unknown>) => ({ method: 'PATCH', body: JSON.stringify(p), headers: { 'Content-Type': 'application/json' } })
    try {
      return (await (await this.send(`documents/${id}/`, body(patch), `изменение документа ${id}`)).json()) as PlDocument
    } catch (e) {
      // Older API versions take the date as created_date.
      if ('created' in patch && e instanceof ToolError && /created/.test(e.message)) {
        const { created, ...rest } = patch
        return (await (await this.send(`documents/${id}/`, body({ ...rest, created_date: created }), `изменение документа ${id}`)).json()) as PlDocument
      }
      throw e
    }
  }

  private async listAll(kind: PlKind): Promise<PlNamed[]> {
    const out: PlNamed[] = []
    for (let page = 1; page <= 20; page++) {
      const data = await this.json<{ results: PlNamed[]; next: string | null }>(`${kind}/`, { page, page_size: 250 }, kind)
      out.push(...data.results)
      if (!data.next) break
    }
    return out
  }

  async taxonomy(): Promise<Taxonomy> {
    const [tags, correspondents, documentTypes] = await Promise.all([this.listAll('tags'), this.listAll('correspondents'), this.listAll('document_types')])
    return { tags, correspondents, documentTypes }
  }

  async create(kind: PlKind, name: string): Promise<PlNamed> {
    const res = await this.send(`${kind}/`, { method: 'POST', body: JSON.stringify({ name }), headers: { 'Content-Type': 'application/json' } }, `создание ${name}`)
    return (await res.json()) as PlNamed
  }
}
