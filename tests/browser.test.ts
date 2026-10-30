import dns from 'node:dns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browser } from '@/lib/connectors/browser'
import { TAB_GONE } from '@/lib/connectors/browser/client'
import { parseNetscapeCookies } from '@/lib/connectors/browser/cookies'
import { checkUrl, domainMatches, parseDomains } from '@/lib/connectors/browser/url'
import { configOf, mockFetch, runTool, runToolRaw, type Call } from './helpers'

const cfg = (extra: Record<string, unknown> = {}) => configOf(browser, { accessKey: 'acc-key', allowActions: true, ...extra })

/** Public by default; a few names resolve to private addresses. */
const DNS: Record<string, string[]> = { 'evil.example': ['93.184.216.34', '10.0.0.5'], 'router.example': ['192.168.1.1'] }

beforeEach(() => {
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async (host: string) => {
    if (host === 'nx.example') throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    return (DNS[host] ?? ['93.184.216.34']).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }) as never)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

type Opts = { snapshot?: string; url?: string; status?: (c: Call) => number | undefined }

function camofox(opts: Opts = {}) {
  return mockFetch(async (c: Call) => {
    const forced = opts.status?.(c)
    if (forced) return Response.json({ error: forced === 404 ? 'Tab not found' : 'Unauthorized' }, { status: forced })
    const p = c.url.pathname
    if (p === '/health') return Response.json({ ok: true, browserRunning: true, activeTabs: 1, activeSessions: 1 })
    if (p === '/openapi.json') return Response.json({ info: { version: '1.18.1' } })
    if (p === '/tabs' && c.method === 'GET') return Response.json({ running: true, tabs: [{ tabId: 't1', url: 'https://news.ycombinator.com/', title: 'Hacker News' }] })
    if (p === '/tabs' && c.method === 'POST') return Response.json({ tabId: 't1', url: 'https://news.ycombinator.com/', httpStatus: 200 })
    if (p.endsWith('/snapshot')) {
      const snap = opts.snapshot ?? '- link "Show HN" [e1]\n- link "Ask HN" [e2]'
      const res: Record<string, unknown> = { url: opts.url ?? 'https://news.ycombinator.com/', snapshot: snap, hasMore: false }
      if (c.url.searchParams.get('includeScreenshot') === 'true') res.screenshot = { data: Buffer.from('png').toString('base64'), mimeType: 'image/png' }
      return Response.json(res)
    }
    if (p.endsWith('/screenshot')) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/png' } })
    if (p.endsWith('/links')) return Response.json({ links: [{ text: 'A', href: 'https://a.example/' }, { text: 'A again', href: 'https://a.example/' }, { text: '', href: 'https://b.example/' }] })
    if (p.endsWith('/extract')) return Response.json({ ok: true, data: { title: 'Show HN' } })
    if (c.method === 'DELETE') return Response.json({ ok: true, closed: 2 })
    if (p === '/youtube/transcript') return Response.json({ status: 'ok', transcript: 'привет мир', video_title: 'Видео', language: 'ru', total_words: 2, available_languages: [{ code: 'ru' }, { code: 'en' }] })
    if (p.startsWith('/sessions/') && p.endsWith('/cookies')) return Response.json({ ok: true, count: 1 })
    if (c.method === 'POST' && p.startsWith('/tabs/')) return Response.json({ ok: true })
    return new Response('nope', { status: 500 })
  })
}

describe('URL validation', () => {
  const none = { allow: [], deny: [] }

  it.each([
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.5:6080/',
    'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:9377/',
    'http://[::1]/',
    'http://[fd00::1]/',
  ])('rejects private address %s', async (url) => {
    await expect(checkUrl(url, none)).rejects.toThrow('приватный адрес')
  })

  it.each(['http://localhost:3000/', 'http://nas.local/', 'http://hub.internal/', 'http://camofox:9377/'])('rejects local name %s', async (url) => {
    await expect(checkUrl(url, none)).rejects.toThrow('локальное имя')
  })

  it('rejects other schemes, hosts resolving to private addresses and unknown hosts', async () => {
    await expect(checkUrl('file:///etc/passwd', none)).rejects.toThrow('только http и https')
    await expect(checkUrl('https://evil.example/', none)).rejects.toThrow('evil.example → 10.0.0.5 — приватный адрес')
    await expect(checkUrl('https://nx.example/', none)).rejects.toThrow('не резолвится')
    expect((await checkUrl('https://93.184.216.34/', none)).hostname).toBe('93.184.216.34')
  })

  it('denylist wins over allowlist; wildcard matches subdomains only', async () => {
    const lists = { allow: parseDomains('wikipedia.org\n*.ycombinator.com'), deny: parseDomains('secret.wikipedia.org') }
    expect(domainMatches('ru.wikipedia.org', 'wikipedia.org')).toBe(true)
    expect(domainMatches('ycombinator.com', '*.ycombinator.com')).toBe(false)
    expect(domainMatches('notwikipedia.org', 'wikipedia.org')).toBe(false)
    await expect(checkUrl('https://ru.wikipedia.org/', lists)).resolves.toBeDefined()
    await expect(checkUrl('https://news.ycombinator.com/', lists)).resolves.toBeDefined()
    await expect(checkUrl('https://ycombinator.com/', lists)).rejects.toThrow('нет в allowlist')
    await expect(checkUrl('https://secret.wikipedia.org/', lists)).rejects.toThrow('в denylist (secret.wikipedia.org)')
    await expect(checkUrl('https://93.184.216.34/', lists)).rejects.toThrow('нет в allowlist')
  })
})

describe('Browser connector', () => {
  it('test() reads health, version and checks the key on /tabs', async () => {
    const calls = camofox()
    expect(await browser.test(cfg())).toMatchObject({ ok: true, summary: 'camofox 1.18.1', version: '1.18.1' })
    expect(calls.find((c) => c.url.pathname === '/health')!.headers.get('authorization')).toBeNull()
    const tabs = calls.find((c) => c.url.pathname === '/tabs')!
    expect(tabs.headers.get('authorization')).toBe('Bearer acc-key')
    expect(tabs.url.searchParams.get('userId')).toBe('hub')
  })

  it('401 means a wrong access key, a refused connection points at the container', async () => {
    camofox({ status: (c) => (c.url.pathname === '/tabs' ? 401 : undefined) })
    expect(await browser.test(cfg())).toMatchObject({ ok: false, summary: expect.stringContaining('неверный access key (401)') })
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))))
    await expect(runTool(browser, 'browser_tabs', cfg())).rejects.toThrow('Браузер недоступен (camofox недоступен: соединение отклонено) — проверь контейнер camofox')
  })

  it('browser_open checks the URL first and returns tab, title and the first page', async () => {
    const calls = camofox()
    const text = await runTool(browser, 'browser_open', cfg(), { url: 'https://news.ycombinator.com' })
    expect(text).toMatch(/^tab: t1\nURL: https:\/\/news\.ycombinator\.com\/\nЗаголовок: Hacker News\n\n- link "Show HN" \[e1\]/)
    expect(JSON.parse(String(calls.find((c) => c.method === 'POST' && c.url.pathname === '/tabs')!.body))).toEqual({ userId: 'hub', sessionKey: 'default', url: 'https://news.ycombinator.com' })

    await expect(runTool(browser, 'browser_open', cfg(), { url: 'http://192.168.1.1/' })).rejects.toThrow('приватный адрес')
    expect(calls.filter((c) => c.method === 'POST' && c.url.pathname === '/tabs')).toHaveLength(1)
  })

  it('a redirect to a private address closes the tab', async () => {
    const calls = camofox({ url: 'http://router.example/admin' })
    await expect(runTool(browser, 'browser_open', cfg(), { url: 'https://short.example/x' })).rejects.toThrow('Вкладка закрыта: страница привела на запрещённый адрес')
    expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/tabs/t1')).toBe(true)
  })

  it('cuts the snapshot to the limit and gives the offset to continue', async () => {
    const calls = camofox({ snapshot: 'x'.repeat(5000) })
    const c = cfg({ snapshotLimit: 2000 })
    const first = await runTool(browser, 'browser_snapshot', c, { tab: 't1' })
    expect(first).toContain(`${'x'.repeat(2000)}\n… (offset для продолжения: 2000)`)
    const second = await runTool(browser, 'browser_snapshot', c, { tab: 't1', offset: 2000 })
    expect(second).toContain('offset для продолжения: 4000')
    expect(calls.at(-1)!.url.searchParams.get('offset')).toBe('2000')
  })

  it('flags a Cloudflare challenge and links VNC', async () => {
    camofox({ snapshot: '- heading "Just a moment..."\n- text "Verify you are human"' })
    const text = await runTool(browser, 'browser_snapshot', cfg({ vncUrl: 'http://192.168.1.5:6080' }), { tab: 't1' })
    expect(text).toContain('проверку Cloudflare')
    expect(text).toContain('VNC: http://192.168.1.5:6080')
  })

  it('an expired tab gets a clear message', async () => {
    camofox({ status: (c) => (c.url.pathname.startsWith('/tabs/') ? 404 : undefined) })
    await expect(runTool(browser, 'browser_snapshot', cfg(), { tab: 'old' })).rejects.toThrow(TAB_GONE)
  })

  it('screenshots come back as images; over 2 MB is refused', async () => {
    camofox()
    const out = await runToolRaw(browser, 'browser_screenshot', cfg(), { tab: 't1' })
    expect(typeof out === 'object' && out.images?.[0]).toEqual({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' })
    const withShot = await runToolRaw(browser, 'browser_snapshot', cfg(), { tab: 't1', screenshot: true })
    expect(typeof withShot === 'object' && withShot.images).toHaveLength(1)

    mockFetch(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } }))
    await expect(runTool(browser, 'browser_screenshot', cfg(), { tab: 't1' })).rejects.toThrow('больше 2 МБ')
  })

  it('links are deduplicated, extract returns JSON, transcript shows the language', async () => {
    camofox()
    expect(await runTool(browser, 'browser_links', cfg(), { tab: 't1' })).toBe('2 ссылки:\n• A — https://a.example/\n• (без текста) — https://b.example/')
    const schema = { type: 'object', properties: { title: { type: 'string', 'x-ref': 'e1' } } }
    expect(JSON.parse(await runTool(browser, 'browser_extract', cfg(), { tab: 't1', schema }))).toEqual({ title: 'Show HN' })
    expect(await runTool(browser, 'browser_youtube_transcript', cfg(), { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).toBe('«Видео» · язык ru · 2 слов\nЕсть ещё: en\n\nпривет мир')
    await expect(runTool(browser, 'browser_youtube_transcript', cfg(), { url: 'https://vimeo.com/1' })).rejects.toThrow('YouTube')
  })
})

describe('browser_act', () => {
  const act = async (args: Record<string, unknown>) => {
    const calls = camofox()
    const text = await runTool(browser, 'browser_act', cfg(), { tab: 't1', ...args })
    const call = calls.find((c) => c.method === 'POST' && c.url.pathname.startsWith('/tabs/t1/'))!
    return { path: call.url.pathname, body: JSON.parse(String(call.body)) as Record<string, unknown>, text }
  }

  it('maps actions to camofox endpoints and returns a fresh snapshot', async () => {
    const click = await act({ action: 'click', ref: 'e1' })
    expect(click).toMatchObject({ path: '/tabs/t1/click', body: { userId: 'hub', ref: 'e1' } })
    expect(click.text).toContain('- link "Show HN" [e1]')
    expect(await act({ action: 'type', ref: 'e2', text: 'камера', submit: true })).toMatchObject({ path: '/tabs/t1/type', body: { ref: 'e2', text: 'камера', submit: true } })
    expect(await act({ action: 'press', key: 'Enter' })).toMatchObject({ path: '/tabs/t1/press', body: { key: 'Enter' } })
    expect(await act({ action: 'scroll' })).toMatchObject({ path: '/tabs/t1/scroll', body: { direction: 'down' } })
    expect(await act({ action: 'navigate', url: 'https://example.com/' })).toMatchObject({ path: '/tabs/t1/navigate', body: { url: 'https://example.com/' } })
    expect(await act({ action: 'navigate', macro: '@google_search', query: 'camofox' })).toMatchObject({ body: { macro: '@google_search', query: 'camofox' } })
    expect(await act({ action: 'back' })).toMatchObject({ path: '/tabs/t1/back' })
    expect(await act({ action: 'wait', selector: '#done', timeoutMs: 5000 })).toMatchObject({ path: '/tabs/t1/wait', body: { selector: '#done', timeout: 5000 } })
  })

  it('validates the navigate URL and required fields', async () => {
    camofox()
    await expect(runTool(browser, 'browser_act', cfg(), { tab: 't1', action: 'navigate', url: 'http://10.0.0.1/' })).rejects.toThrow('приватный адрес')
    await expect(runTool(browser, 'browser_act', cfg(), { tab: 't1', action: 'click' })).rejects.toThrow('ref или selector')
    await expect(runTool(browser, 'browser_act', cfg(), { tab: 't1', action: 'type', ref: 'e1' })).rejects.toThrow('нужен text')
  })

  it('read-only mode refuses actions and session resets', async () => {
    camofox()
    const ro = cfg({ allowActions: false })
    await expect(runTool(browser, 'browser_act', ro, { tab: 't1', action: 'back' })).rejects.toThrow('включено только чтение')
    await expect(runTool(browser, 'browser_open', ro, { url: 'https://example.com', newSession: true })).rejects.toThrow('включено только чтение')
  })
})

describe('tool visibility and cookies', () => {
  it('hides action tools while read-only and the import without an API key', () => {
    expect(browser.hiddenTools!(cfg({ allowActions: false }))).toEqual(['browser_act', 'browser_close', 'browser_import_cookies'])
    expect(browser.hiddenTools!(cfg())).toEqual(['browser_import_cookies'])
    expect(browser.hiddenTools!(cfg({ apiKey: 'api' }))).toEqual([])
  })

  it('every read tool is read-only, actions are not', () => {
    const ro = Object.fromEntries(browser.tools.map((t) => [t.name, t.annotations.readOnlyHint === true]))
    expect(ro).toMatchObject({ browser_open: true, browser_snapshot: true, browser_screenshot: true, browser_act: false, browser_close: false, browser_import_cookies: false })
  })

  it('parses Netscape cookies with HttpOnly and session cookies', () => {
    const text = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tabc\n#HttpOnly_.google.com\tTRUE\t/\tFALSE\t0\tHSID\tx\ty\nbroken line'
    expect(parseNetscapeCookies(text)).toEqual([
      { domain: '.youtube.com', path: '/', secure: true, expires: 1893456000, name: 'SID', value: 'abc', httpOnly: false },
      { domain: '.google.com', path: '/', secure: false, expires: -1, name: 'HSID', value: 'x\ty', httpOnly: true },
    ])
  })
})
