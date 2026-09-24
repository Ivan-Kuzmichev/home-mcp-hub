import fs from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { configOf, runTool, setupTempDb } from './helpers'

const cleanup = await setupTempDb()
process.env.BETTER_AUTH_SECRET = 'x'.repeat(40)
process.env.BASE_URL = 'https://hub.example.com'

const store = await import('@/lib/prototypes/store')
const access = await import('@/lib/prototypes/access')
const { prototypes } = await import('@/lib/connectors/prototypes')
const route = await import('@/app/p/[slug]/route')

afterAll(cleanup)

const HTML = '<!doctype html><title>t</title><h1>Hello</h1>'
const cfg = configOf(prototypes, {})
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) })

describe('prototype storage', () => {
  it('publishes with a readable random slug and keeps the last 3 versions', async () => {
    const p = await store.publish({ html: HTML, title: 'Dashboard' })
    expect(p.slug).toMatch(/^[2-9a-km-z]{10}$/)
    let cur = p
    for (let i = 2; i <= 5; i++) cur = await store.update(cur, { html: `${HTML}<p>v${i}</p>` })
    expect(store.listVersions(p.id).map((v) => v.version)).toEqual([5, 4, 3])
    expect(store.readHtml(cur)).toContain('v5')

    const rolled = await store.rollback(cur, 3)
    expect(rolled.version).toBe(6)
    expect(store.readHtml(rolled)).toContain('v3')
    expect(store.listVersions(p.id).map((v) => v.version)).toEqual([6, 5, 4])
  })

  it('hashes the pin and bumps pin_version on every change', async () => {
    const p = await store.publish({ html: HTML, title: 'Pinned', pin: '4821' })
    expect(p.pinHash).toMatch(/^\$argon2id\$/)
    expect(await store.verifyPin(p, '4821')).toBe(true)
    expect(await store.verifyPin(p, '0000')).toBe(false)
    const changed = await store.update(p, { pin: '1111' })
    expect(changed.pinVersion).toBe(p.pinVersion + 1)
    const open = await store.update(changed, { pin: null })
    expect(open.pinHash).toBeNull()
    await expect(store.publish({ html: HTML, title: 'x', pin: '12' })).rejects.toThrow('4 до 8')
  })

  it('enforces size limits and purges long-expired prototypes', async () => {
    await expect(store.publish({ html: 'x'.repeat(2 * 1024 * 1024), title: 'big', maxBytes: store.MAX_TOOL_HTML_BYTES })).rejects.toThrow('лимита 1 МБ')
    const p = await store.publish({ html: HTML, title: 'Old', expiry: '7d' })
    const dir = `${store.prototypesDir()}/${p.id}`
    expect(store.purgeExpired(new Date(Date.now() + 10 * 86_400_000))).toBe(0) // expired 3 days ago: still 410
    expect(store.purgeExpired(new Date(Date.now() + 15 * 86_400_000))).toBeGreaterThan(0)
    expect(store.getById(p.id)).toBeUndefined()
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('reads slugs from links', () => {
    expect(store.slugFrom('https://hub.example.com/p/abc234defg')).toBe('abc234defg')
    expect(store.slugFrom('/p/ABC234DEFG')).toBe('abc234defg')
    expect(store.slugFrom('abc234defg')).toBe('abc234defg')
  })
})

describe('access cookie and attempt limit', () => {
  const p = { slug: 'slugslug22', pinVersion: 3 }

  it('is bound to slug, pin version and expiry', () => {
    const v = access.signAccess(p)
    expect(access.verifyAccess(v, p)).toBe(true)
    expect(access.verifyAccess(v, { ...p, pinVersion: 4 })).toBe(false)
    expect(access.verifyAccess(v, { ...p, slug: 'otherslug2' })).toBe(false)
    expect(access.verifyAccess(v, p, Date.now() + 25 * 3600_000)).toBe(false)
    expect(access.verifyAccess(v.slice(0, -2) + 'xx', p)).toBe(false)
    expect(access.verifyAccess(undefined, p)).toBe(false)
  })

  it('allows 5 attempts per IP and 30 per slug in 10 minutes', () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++) access.recordFailedAttempt('lim1', '1.1.1.1', now)
    expect(access.attemptState('lim1', '1.1.1.1', now)).toMatchObject({ allowed: false, remaining: 0 })
    expect(access.attemptState('lim1', '2.2.2.2', now).allowed).toBe(true)
    expect(access.attemptState('lim1', '1.1.1.1', now + 10 * 60_000 + 1).allowed).toBe(true)

    for (let i = 0; i < 30; i++) access.recordFailedAttempt('lim2', `10.0.0.${i}`, now)
    expect(access.attemptState('lim2', '9.9.9.9', now).allowed).toBe(false)
  })
})

describe('public route /p/{slug}', () => {
  it('serves open prototypes with the sandbox CSP and noindex, counting views', async () => {
    const p = await store.publish({ html: HTML, title: 'Open' })
    const res = await route.GET(new Request(`https://hub.example.com/p/${p.slug}`), ctx(p.slug))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-forms allow-modals allow-popups')
    expect(res.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
    expect(await res.text()).toBe(HTML)
    expect(store.getById(p.id)?.views).toBe(1)
  })

  it('404 for unknown slugs, 410 for expired prototypes', async () => {
    expect((await route.GET(new Request('https://hub.example.com/p/nopenopeno'), ctx('nopenopeno'))).status).toBe(404)
    const p = await store.publish({ html: HTML, title: 'Exp', expiry: '7d' })
    await store.update(p, {})
    const { getDb } = await import('@/lib/db')
    const { prototype } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')
    getDb().update(prototype).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(prototype.id, p.id)).run()
    expect((await route.GET(new Request(`https://hub.example.com/p/${p.slug}`), ctx(p.slug))).status).toBe(410)
  })

  it('pin flow: 401 with remaining attempts, 429 when locked, cookie on success', async () => {
    const p = await store.publish({ html: HTML, title: 'Locked', pin: '4821' })
    const post = (pin: string, ip = '5.5.5.5') =>
      route.POST(new Request(`https://hub.example.com/p/${p.slug}`, { method: 'POST', headers: { 'x-real-ip': ip, 'content-type': 'application/json' }, body: JSON.stringify({ pin }) }), ctx(p.slug))

    const wrong = await post('0000')
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ error: 'wrong_pin', remaining: 4 })

    const ok = await post('4821')
    expect(ok.status).toBe(200)
    const cookie = ok.headers.get('set-cookie')!
    expect(cookie).toContain(`Path=/p/${p.slug}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Max-Age=86400')

    for (let i = 0; i < 4; i++) await post('0000', '6.6.6.6')
    const locked = await post('0000', '6.6.6.6')
    expect(locked.status).toBe(429)
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0)
    // even the right pin waits until the window passes
    expect((await post('4821', '6.6.6.6')).status).toBe(429)
  })
})

describe('prototype tools', () => {
  it('publishes and lists with public links', async () => {
    const text = await runTool(prototypes, 'prototype_publish', cfg, { title: 'Калькулятор', html: HTML, pin: '4821', expires: '30d' })
    expect(text).toMatch(/^Опубликовано: «Калькулятор»\nhttps:\/\/hub\.example\.com\/p\/[2-9a-km-z]{10}\nПин задан · до /)
    expect(await runTool(prototypes, 'prototype_list', cfg)).toContain('«Калькулятор» — https://hub.example.com/p/')
  })

  it('updates by link and needs confirm to delete', async () => {
    const pub = await runTool(prototypes, 'prototype_publish', cfg, { title: 'Temp', html: HTML })
    const url = pub.split('\n')[1]!
    expect(await runTool(prototypes, 'prototype_update', cfg, { prototype: url, html: `${HTML}!`, pin: '5555' })).toContain('HTML → v2, пин сменён')
    expect(await runTool(prototypes, 'prototype_delete', cfg, { prototype: url })).toContain('confirm: true')
    expect(store.getBySlug(store.slugFrom(url))).toBeDefined()
    expect(await runTool(prototypes, 'prototype_delete', cfg, { prototype: url, confirm: true })).toBe('Удалён прототип «Temp»')
    expect(store.getBySlug(store.slugFrom(url))).toBeUndefined()
  })

  it('marks delete as destructive and list as read-only', () => {
    const hints = Object.fromEntries(prototypes.tools.map((t) => [t.name, t.annotations]))
    expect(hints.prototype_delete?.destructiveHint).toBe(true)
    expect(hints.prototype_list?.readOnlyHint).toBe(true)
  })
})
