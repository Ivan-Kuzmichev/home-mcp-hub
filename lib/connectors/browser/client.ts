import { scrub, serviceFetch } from '../http'
import { ToolError } from '../types'

export type CamofoxConfig = { baseUrl: string; accessKey?: string; apiKey?: string; userId: string; timeoutSec: number }

export type SnapshotPage = { url: string; snapshot: string; hasMore?: boolean; nextOffset?: number; totalChars?: number; screenshot?: { data: string; mimeType: string } }
export type TabInfo = { tabId: string; url: string; title: string; listItemId?: string }
export type Health = { ok: boolean; browserRunning?: boolean; activeTabs?: number; activeSessions?: number; recovering?: boolean }

export const TAB_GONE = 'Вкладка закрыта по таймауту — открой заново через browser_open'
const SERVICE = 'camofox'
export const MAX_CONCURRENT = 3

// ---------------------------------------------------------------------------
// At most MAX_CONCURRENT calls in flight; the rest wait in line until their own timeout.

const globalForBrowser = globalThis as unknown as { __hubCamofoxSlots?: { busy: number; queue: (() => void)[] } }
const slots = (globalForBrowser.__hubCamofoxSlots ??= { busy: 0, queue: [] })

async function acquire(timeoutMs: number): Promise<void> {
  if (slots.busy < MAX_CONCURRENT) {
    slots.busy++
    return
  }
  await new Promise<void>((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer)
      slots.busy++
      resolve()
    }
    const timer = setTimeout(() => {
      slots.queue.splice(slots.queue.indexOf(grant), 1)
      reject(new ToolError(`Браузер занят: уже ${MAX_CONCURRENT} запроса выполняются, очередь не дошла за ${Math.round(timeoutMs / 1000)} с`))
    }, timeoutMs)
    slots.queue.push(grant)
  })
}

function release(): void {
  slots.busy--
  slots.queue.shift()?.()
}

// ---------------------------------------------------------------------------

/** `tab`: a 404 means the tab expired. `missingOk`: a 404 is not an error (nothing to close). */
type CallOpts = { query?: Record<string, string | number | undefined>; body?: unknown; auth?: 'access' | 'api'; tab?: boolean; missingOk?: boolean }

export class CamofoxClient {
  constructor(private readonly cfg: CamofoxConfig) {}

  get userId(): string {
    return this.cfg.userId
  }

  private async call(method: string, path: string, opts: CallOpts = {}): Promise<Response> {
    const url = new URL(`${this.cfg.baseUrl}${path}`)
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    const headers: Record<string, string> = {}
    const key = opts.auth === 'api' ? this.cfg.apiKey : this.cfg.accessKey
    if (key) headers.Authorization = `Bearer ${key}`
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    const timeoutMs = this.cfg.timeoutSec * 1000

    await acquire(timeoutMs)
    let res: Response
    try {
      res = await serviceFetch(SERVICE, url.toString(), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), timeoutMs })
    } catch (e) {
      if (e instanceof ToolError) throw new ToolError(`Браузер недоступен (${e.message}) — проверь контейнер camofox и адрес в настройках`)
      throw e
    } finally {
      release()
    }
    if (res.ok || (res.status === 404 && opts.missingOk)) return res

    const reason = await errorReason(res)
    if (res.status === 401) throw new ToolError('Браузер: неверный access key (401) — проверь настройки коннектора')
    if (res.status === 403 && opts.auth === 'api') throw new ToolError('Браузер: неверный API key (403) — импорт cookies запрещён')
    if (res.status === 404 && opts.tab) throw new ToolError(TAB_GONE)
    if (res.status === 409) throw new ToolError(`Страница изменилась — сделай browser_snapshot и повтори с новыми ref (${reason || 409})`)
    throw new ToolError(`Браузер: ошибка ${res.status}${reason ? ` (${reason})` : ''}`)
  }

  private async json<T>(method: string, path: string, opts?: CallOpts): Promise<T> {
    return (await (await this.call(method, path, opts)).json()) as T
  }

  async health(): Promise<Health> {
    const res = await serviceFetch(SERVICE, `${this.cfg.baseUrl}/health`, { timeoutMs: this.cfg.timeoutSec * 1000 }).catch((e: unknown) => {
      throw e instanceof ToolError ? new ToolError(`Браузер недоступен (${e.message}) — проверь контейнер camofox`) : e
    })
    const body = (await res.json().catch(() => ({ ok: false }))) as Health
    return { ...body, ok: res.ok && body.ok }
  }

  /** camofox has no version in /health; the OpenAPI document carries it. */
  async version(): Promise<string> {
    const doc = await this.json<{ info?: { version?: string } }>('GET', '/openapi.json')
    return doc.info?.version ?? '?'
  }

  async tabs(): Promise<TabInfo[]> {
    return (await this.json<{ tabs?: TabInfo[] }>('GET', '/tabs', { query: { userId: this.userId } })).tabs ?? []
  }

  openTab(sessionKey: string, url: string): Promise<{ tabId: string; url: string; httpStatus?: number | null }> {
    return this.json('POST', '/tabs', { body: { userId: this.userId, sessionKey, url } })
  }

  snapshot(tab: string, offset?: number, screenshot?: boolean): Promise<SnapshotPage> {
    return this.json('GET', `/tabs/${encodeURIComponent(tab)}/snapshot`, {
      tab: true,
      query: { userId: this.userId, offset: offset || undefined, includeScreenshot: screenshot ? 'true' : undefined },
    })
  }

  async links(tab: string): Promise<{ text: string; href: string }[]> {
    return (await this.json<{ links?: { text: string; href: string }[] }>('GET', `/tabs/${encodeURIComponent(tab)}/links`, { tab: true, query: { userId: this.userId } })).links ?? []
  }

  async screenshot(tab: string): Promise<{ data: Buffer; mimeType: string }> {
    const res = await this.call('GET', `/tabs/${encodeURIComponent(tab)}/screenshot`, { tab: true, query: { userId: this.userId } })
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type')?.split(';')[0] ?? 'image/png' }
  }

  async extract(tab: string, schema: unknown): Promise<unknown> {
    return (await this.json<{ data?: unknown }>('POST', `/tabs/${encodeURIComponent(tab)}/extract`, { tab: true, body: { userId: this.userId, schema } })).data
  }

  /** POST /tabs/:id/<action> with the userId added; returns the final URL when camofox reports one. */
  async act(tab: string, action: string, body: Record<string, unknown>): Promise<{ url?: string }> {
    return this.json('POST', `/tabs/${encodeURIComponent(tab)}/${action}`, { tab: true, body: { userId: this.userId, ...body } })
  }

  async closeTab(tab: string): Promise<void> {
    await this.call('DELETE', `/tabs/${encodeURIComponent(tab)}`, { tab: true, query: { userId: this.userId } })
  }

  async closeGroup(sessionKey: string): Promise<number> {
    const res = await this.call('DELETE', `/tabs/group/${encodeURIComponent(sessionKey)}`, { query: { userId: this.userId }, missingOk: true })
    return res.ok ? (((await res.json()) as { closed?: number }).closed ?? 0) : 0
  }

  /** Drop cookies and the profile of this userId. No session yet is fine. */
  async resetSession(): Promise<void> {
    await this.call('DELETE', `/sessions/${encodeURIComponent(this.userId)}`, { missingOk: true })
  }

  async importCookies(cookies: unknown[]): Promise<number> {
    return (await this.json<{ count?: number }>('POST', `/sessions/${encodeURIComponent(this.userId)}/cookies`, { auth: 'api', body: { cookies } })).count ?? cookies.length
  }

  youtubeTranscript(url: string, languages: string[]): Promise<YoutubeTranscript> {
    return this.json('POST', '/youtube/transcript', { body: { url, languages } })
  }
}

export type YoutubeTranscript = {
  status: string
  transcript?: string
  video_title?: string
  language?: string
  total_words?: number
  available_languages?: { code: string; name?: string }[]
  code?: string | number
  message?: string
  error?: string
}

async function errorReason(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown }
    const msg = body.error ?? body.message
    if (typeof msg === 'string') return scrub(msg).slice(0, 160)
  } catch {
    // not JSON
  }
  return scrub(text).slice(0, 160)
}
