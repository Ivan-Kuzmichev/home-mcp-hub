import { expectOk, serviceFetch } from '../http'
import { ToolError } from '../types'
import { t } from '../../i18n'

export type PaConfig = { baseUrl: string; apiKey?: string; organizationId?: string }

export type PaTag = { id: string; name: string; documentsCount?: number }

export type PaDocument = {
  id: string
  name: string
  originalName?: string | null
  mimeType: string
  originalSize?: number
  /** Absent in search results, only GET of one document has it */
  content?: string
  documentDate?: string | null
  notes?: string | null
  createdAt: string
  isDeleted?: boolean
  tags: PaTag[]
  customProperties?: unknown[]
}

export type PaOrganization = { id: string; name?: string }

const SERVICE = 'Papra'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

export class PaClient {
  private org: Promise<PaOrganization> | null = null

  constructor(private readonly cfg: PaConfig) {}

  private async send(path: string, init: RequestInit & { params?: Record<string, string | number | undefined>; allow?: number[]; timeoutMs?: number } = {}, what = path): Promise<Response> {
    if (!this.cfg.apiKey) throw new ToolError(t`${SERVICE}: API key is not set`)
    const { params, allow, ...rest } = init
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') q.set(k, String(v))
    const qs = q.toString()
    const res = await serviceFetch(SERVICE, `${this.cfg.baseUrl}/api/${path}${qs ? `?${qs}` : ''}`, {
      ...rest,
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, Accept: 'application/json', ...(rest.headers as Record<string, string>) },
    })
    if (allow?.includes(res.status)) return res
    // Papra answers 401 both for a wrong key and for a key without the permission.
    if (res.status === 401 || res.status === 403) throw new ToolError(t`${SERVICE}: wrong API key or it lacks permissions (${what})`)
    if (res.status === 404) throw new ToolError(t`${SERVICE}: not found (${what})`)
    return expectOk(SERVICE, res, what)
  }

  /** The configured organization, or the only one the key can see. */
  organization(): Promise<PaOrganization> {
    this.org ??= this.resolveOrganization()
    return this.org
  }

  private async resolveOrganization(): Promise<PaOrganization> {
    if (this.cfg.organizationId) return { id: this.cfg.organizationId }
    const res = await this.send('organizations', {}, t`organization list`)
    const { organizations } = (await res.json()) as { organizations: { id: string; name: string }[] }
    const [first, ...others] = organizations
    if (!first) throw new ToolError(t`${SERVICE}: the user has no organizations`)
    if (others.length) {
      const list = organizations.map((o) => `${o.name} (${o.id})`).join(', ')
      throw new ToolError(t`${SERVICE}: there are several organizations — set the ID of the right one in the connector settings: ${list}`)
    }
    return { id: first.id, name: first.name }
  }

  private async orgPath(path: string): Promise<string> {
    const { id } = await this.organization()
    return `organizations/${encodeURIComponent(id)}/${path}`
  }

  private docPath(id: string): string {
    return `documents/${encodeURIComponent(id)}`
  }

  async documentCount(): Promise<number> {
    const res = await this.send(await this.orgPath('documents/statistics'), {}, t`statistics`)
    return ((await res.json()) as { organizationStats: { documentsCount: number } }).organizationStats.documentsCount
  }

  /** Requires Papra 26.5+: older versions silently ignore searchQuery on this route. */
  async documents(params: { searchQuery?: string; pageIndex?: number; pageSize?: number }): Promise<{ count: number; documents: PaDocument[] }> {
    const res = await this.send(await this.orgPath('documents'), { params }, t`document search`)
    const data = (await res.json()) as { documents: PaDocument[]; documentsCount: number }
    return { count: data.documentsCount, documents: data.documents }
  }

  async document(id: string): Promise<PaDocument> {
    const res = await this.send(await this.orgPath(this.docPath(id)), {}, t`document ${id}`)
    return ((await res.json()) as { document: PaDocument }).document
  }

  /** Streams the original file. Papra always answers application/octet-stream: the real type is in the document. */
  async file(id: string): Promise<Response> {
    return this.send(await this.orgPath(`${this.docPath(id)}/file`), {}, t`download`)
  }

  /** The reply has no tags, so the caller keeps its own picture of the document. */
  async update(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.send(await this.orgPath(this.docPath(id)), { method: 'PATCH', body: JSON.stringify(patch), headers: JSON_HEADERS }, t`updating document ${id}`)
  }

  /** A new document. Papra starts its OCR in the background, so the text is not there yet. */
  async upload(file: Buffer, name: string, mimeType: string): Promise<PaDocument> {
    const body = new FormData()
    body.set('file', new Blob([new Uint8Array(file)], { type: mimeType }), name)
    const res = await this.send(await this.orgPath('documents'), { method: 'POST', body, timeoutMs: 120_000 }, t`uploading the document`)
    return ((await res.json()) as { document: PaDocument }).document
  }

  /** To the trash: Papra purges it later, until then it can be restored in the web interface. */
  async trash(id: string): Promise<void> {
    await this.send(await this.orgPath(this.docPath(id)), { method: 'DELETE' }, t`deleting document ${id}`)
  }

  async tags(): Promise<PaTag[]> {
    const res = await this.send(await this.orgPath('tags'), {}, t`tags`)
    return ((await res.json()) as { tags: PaTag[] }).tags
  }

  async createTag(name: string, color: string): Promise<PaTag> {
    const res = await this.send(await this.orgPath('tags'), { method: 'POST', body: JSON.stringify({ name, color }), headers: JSON_HEADERS }, t`creating tag ${name}`)
    return ((await res.json()) as { tag: PaTag }).tag
  }

  async addTag(id: string, tagId: string): Promise<void> {
    // 409: the document already has the tag, which is exactly what was asked for.
    await this.send(await this.orgPath(`${this.docPath(id)}/tags`), { method: 'POST', body: JSON.stringify({ tagId }), headers: JSON_HEADERS, allow: [409] }, t`adding a tag to document ${id}`)
  }

  async removeTag(id: string, tagId: string): Promise<void> {
    await this.send(await this.orgPath(`${this.docPath(id)}/tags/${encodeURIComponent(tagId)}`), { method: 'DELETE' }, t`removing a tag from document ${id}`)
  }
}
