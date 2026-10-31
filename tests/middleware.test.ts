import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const PREFIX = 'gfgsfv2rfdAbc123'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'))
process.env.DATABASE_PATH = path.join(tmp, 'hub.db')

// The admin gate asks better-auth for the session; tests decide the answer.
let signedIn = true
vi.doMock('@/lib/session', () => ({ hasAdminSession: async () => signedIn }))

// Imported after DATABASE_PATH is set: the DB opens lazily on first use.
const { decideRoute, prefixMatches, savePrefix, generatePrefix, PREFIX_PATTERN, withPrefix } = await import('@/lib/prefix')
const { getDb } = await import('@/lib/db')
const { middleware, isPagePath, isAdminPath } = await import('@/middleware')
const { SlidingWindow } = await import('@/lib/rate-limit')

async function run(pathname: string) {
  return middleware(new NextRequest(new URL(pathname, 'https://hub.example.com')))
}

function rewrittenTo(res: Response): string | null {
  const header = res.headers.get('x-middleware-rewrite')
  return header ? new URL(header).pathname : null
}

beforeAll(() => {
  getDb().run('CREATE TABLE IF NOT EXISTS setting (key text PRIMARY KEY NOT NULL, value text NOT NULL)')
  savePrefix(PREFIX)
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('admin gate', () => {
  it('redirects admin pages to the login with an empty body when there is no session', async () => {
    signedIn = false
    try {
      for (const page of ['/admin', '/admin/activity', '/admin/scripts', '/admin/connectors/jackett']) {
        const res = await run(`/${PREFIX}${page}`)
        expect(res.status).toBe(307)
        expect(res.headers.get('location')).toBe(`https://hub.example.com/${PREFIX}/login`)
        expect(rewrittenTo(res)).toBeNull()
        expect(await res.text()).toBe('')
      }
      // The login page and the auth API stay reachable.
      expect(rewrittenTo(await run(`/${PREFIX}/login`))).toBe('/login')
      expect(rewrittenTo(await run(`/${PREFIX}/api/auth/get-session`))).toBe('/api/auth/get-session')
      // «/adminx» is not an admin page.
      expect(isAdminPath('/adminx')).toBe(false)
    } finally {
      signedIn = true
    }
  })
})

describe('middleware', () => {
  it('rewrites the correct prefix to the internal path', async () => {
    const res = await run(`/${PREFIX}/admin`)
    expect(res.status).toBe(200)
    expect(rewrittenTo(res)).toBe('/admin')
  })

  it('rewrites nested paths and keeps the query string', async () => {
    const res = await run(`/${PREFIX}/api/auth/get-session?x=1`)
    expect(rewrittenTo(res)).toBe('/api/auth/get-session')
    expect(new URL(res.headers.get('x-middleware-rewrite')!).search).toBe('?x=1')
  })

  it('rewrites the bare prefix to the internal root', async () => {
    expect(rewrittenTo(await run(`/${PREFIX}`))).toBe('/')
  })

  it.each([
    ['wrong prefix', '/wrongprefix0000/admin'],
    ['almost the prefix', `/${PREFIX.slice(0, -1)}/admin`],
    ['prefix with a tail', `/${PREFIX}x/admin`],
    ['root', '/'],
    ['admin without prefix', '/admin'],
    ['login without prefix', '/login'],
    ['mcp without prefix', '/api/mcp'],
    ['auth without prefix', '/api/auth/get-session'],
    ['root well-known', '/.well-known/oauth-authorization-server'],
    ['root protected resource', '/.well-known/oauth-protected-resource'],
    ['well-known with wrong secret', '/.well-known/oauth-authorization-server/nope'],
    ['PRM path-insert with wrong secret', '/.well-known/oauth-protected-resource/nope/api/mcp'],
    ['prototypes under the prefix', `/${PREFIX}/p/abc`],
    ['download links under the prefix', `/${PREFIX}/f/abc`],
    ['next internals other than static', '/_next/image?url=x'],
    ['favicon', '/favicon.ico'],
  ])('returns an empty 404 for %s', async (_name, pathname) => {
    const res = await run(pathname)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
    expect(rewrittenTo(res)).toBeNull()
  })

  it.each([
    ['prototype', '/p/Ab3xK9qZ'],
    ['document download link', '/f/abcdefghijklmnopqrstuvwxyzABCDEF'],
    ['static assets', '/_next/static/chunks/main.js'],
    ['AS metadata, RFC 8414 path-insert', `/.well-known/oauth-authorization-server/${PREFIX}`],
    ['AS metadata, OIDC path-insert', `/.well-known/openid-configuration/${PREFIX}`],
    ['PRM under the prefix', `/${PREFIX}/.well-known/oauth-protected-resource`],
    ['PRM, RFC 9728 path-insert', `/.well-known/oauth-protected-resource/${PREFIX}/api/mcp`],
    ['OIDC path-append', `/${PREFIX}/.well-known/openid-configuration`],
  ])('passes %s through unchanged', async (_name, pathname) => {
    const res = await run(pathname)
    expect(res.status).toBe(200)
    expect(rewrittenTo(res)).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('marks prototypes noindex', async () => {
    expect((await run('/p/Ab3xK9qZ')).headers.get('x-robots-tag')).toContain('noindex')
    expect((await run(`/${PREFIX}/admin`)).headers.get('x-robots-tag')).toBeNull()
  })

  it('sets no-referrer so the prefix does not leak via links', async () => {
    expect((await run(`/${PREFIX}/admin`)).headers.get('referrer-policy')).toBe('no-referrer')
  })
})

describe('decideRoute', () => {
  it('returns 404 for everything but prototypes and assets when no prefix is set', async () => {
    expect(decideRoute('/anything/admin', null)).toEqual({ type: 'notFound' })
    expect(decideRoute('/p/abc', null)).toEqual({ type: 'pass' })
  })

  it('lets Next dev internals through only in dev', async () => {
    expect(decideRoute('/_next/webpack-hmr', PREFIX, { dev: true })).toEqual({ type: 'pass' })
    expect(decideRoute('/_next/webpack-hmr', PREFIX)).toEqual({ type: 'notFound' })
  })
})

describe('prefix helpers', () => {
  it('compares exactly', async () => {
    expect(prefixMatches(PREFIX, PREFIX)).toBe(true)
    expect(prefixMatches(PREFIX.toLowerCase(), PREFIX)).toBe(false)
    expect(prefixMatches('', PREFIX)).toBe(false)
  })

  it('generates base62 prefixes of the right length', async () => {
    const p = generatePrefix()
    expect(p).toMatch(PREFIX_PATTERN)
    expect(p).toHaveLength(14)
    expect(generatePrefix()).not.toBe(p)
  })

  it('builds in-app URLs', async () => {
    expect(withPrefix('abc', '/admin')).toBe('/abc/admin')
    expect(withPrefix('abc', 'login')).toBe('/abc/login')
    expect(withPrefix('abc', '/')).toBe('/abc')
  })

  it('rejects malformed prefixes', async () => {
    expect(() => savePrefix('short')).toThrow()
    expect(() => savePrefix('has/slash0000000')).toThrow()
  })
})

describe('page CSP', () => {
  it('gives Next pages a nonce CSP without unsafe-inline scripts', async () => {
    const res = await run(`/${PREFIX}/admin`)
    const csp = res.headers.get('content-security-policy')!
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce).toBeTruthy()
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/)
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(csp).toContain("frame-ancestors 'none'")
    // Next.js reads the nonce from the request CSP header.
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp)
    expect((await run(`/${PREFIX}/admin`)).headers.get('content-security-policy')).not.toContain(nonce!)
  })

  it.each([
    ['/admin', true],
    ['/login', true],
    ['/consent', true],
    ['/p/abc/pin', true],
    ['/p/abc', false],
    ['/api/mcp', false],
    ['/api/auth/get-session', false],
    ['/admin/prototypes/123/preview', false],
    ['/admin/activity/export', false],
  ])('%s is a page: %s', (path, expected) => {
    expect(isPagePath(path)).toBe(expected)
  })

  it('leaves prototype HTML to its own sandbox CSP', async () => {
    expect((await run('/p/Ab3xK9qZ')).headers.get('content-security-policy')).toBeNull()
  })
})

describe('sliding window limiter', () => {
  it('allows N hits per window, then asks to retry', async () => {
    const w = new SlidingWindow(3, 60_000)
    const t = 1_000_000
    expect([w.hit('a', t), w.hit('a', t), w.hit('a', t)].every((r) => r.allowed)).toBe(true)
    expect(w.hit('a', t + 1000)).toEqual({ allowed: false, retryAfterSec: 59 })
    expect(w.hit('b', t).allowed).toBe(true)
    expect(w.hit('a', t + 60_001).allowed).toBe(true)
  })
})
