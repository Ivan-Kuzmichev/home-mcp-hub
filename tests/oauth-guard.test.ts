import { afterAll, describe, expect, it } from 'vitest'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { guardAuthRequest, withDefaultResource } = await import('@/lib/oauth-guard')
const { setDcrAllowed } = await import('@/lib/settings')
const { setAllowedClients, allowedRedirect } = await import('@/lib/oauth-clients')
const { queryJournal } = await import('@/lib/journal')

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback'
const RESOURCE = 'https://hub.example.com/secret0000000/api/mcp'
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer
const json = (v: unknown) => enc(JSON.stringify(v))
const noSession = async () => null
const withTwoFactor = async () => ({ user: { twoFactorEnabled: true } })
const withoutTwoFactor = async () => ({ user: { twoFactorEnabled: false } })

function register(redirect_uris: unknown) {
  return guardAuthRequest(
    { method: 'POST', path: '/oauth2/register', body: json({ redirect_uris }), contentType: 'application/json' },
    noSession,
  )
}

afterAll(cleanup)

describe('client registration', () => {
  it('is refused while allow_dcr is off', async () => {
    setDcrAllowed(false)
    const res = await register([CLAUDE])
    expect(res?.status).toBe(403)
    expect(await res?.json()).toMatchObject({ error: 'access_denied' })
  })

  it('accepts Claude and ChatGPT by default and refuses anything else', async () => {
    setDcrAllowed(true)
    expect(await register([CLAUDE])).toBeNull()
    expect(await register([CLAUDE, 'https://claude.com/api/mcp/auth_callback'])).toBeNull()
    expect(await register(['https://chatgpt.com/connector_platform_oauth_redirect'])).toBeNull()
    expect(await register(['https://chatgpt.com/connector/oauth/abc_123-XY'])).toBeNull()
    expect((await register(['https://evil.example.com/cb']))?.status).toBe(400)
    expect((await register([CLAUDE, 'https://evil.example.com/cb']))?.status).toBe(400)
    expect((await register(['https://chatgpt.com/connector_platform_oauth_redirect?x=1']))?.status).toBe(400)
    expect((await register(['https://chatgpt.com.evil.io/connector_platform_oauth_redirect']))?.status).toBe(400)
    expect((await register([]))?.status).toBe(400)
    expect((await register('https://claude.ai/api/mcp/auth_callback'))?.status).toBe(400)
  })

  it('allows loopback redirects (Claude Code) only when switched on', async () => {
    setDcrAllowed(true)
    const local = ['http://localhost:53682/callback']
    expect((await register(local))?.status).toBe(400)
    setAllowedClients(['claude', 'chatgpt', 'loopback'])
    expect(await register(local)).toBeNull()
    expect(await register(['http://127.0.0.1:9000/cb'])).toBeNull()
    setAllowedClients(['claude'])
    expect((await register(['https://chatgpt.com/connector_platform_oauth_redirect']))?.status).toBe(400)
    expect(allowedRedirect('https://user:pw@claude.ai/api/mcp/auth_callback', ['claude'])).toBeNull()
    setAllowedClients(['claude', 'chatgpt'])
  })

  it('journals refused registrations with the redirect URIs', async () => {
    setDcrAllowed(true)
    await register(['https://evil.example.com/cb'])
    const row = queryJournal({ connector: 'auth' }).find((r) => r.tool === 'auth.register')
    expect(row?.ok).toBe(false)
    expect(row?.argsRedacted).toContain('https://evil.example.com/cb')
  })
})

describe('consent', () => {
  const consent = (getSession: () => Promise<{ user: { twoFactorEnabled: boolean } } | null>) =>
    guardAuthRequest({ method: 'POST', path: '/oauth2/consent', body: json({ accept: true }), contentType: 'application/json' }, getSession)

  it('requires a session that completed 2FA', async () => {
    expect((await consent(noSession))?.status).toBe(403)
    expect((await consent(withoutTwoFactor))?.status).toBe(403)
    expect(await consent(withTwoFactor)).toBeNull()
  })
})

describe('client management endpoints', () => {
  it.each(['/oauth2/create-client', '/oauth2/update-client', '/admin/oauth2/create-client'])('blocks %s', async (p) => {
    const res = await guardAuthRequest({ method: 'POST', path: p, body: json({}), contentType: 'application/json' }, withTwoFactor)
    expect(res?.status).toBe(404)
  })

  it('lets the rest through', async () => {
    expect(await guardAuthRequest({ method: 'POST', path: '/sign-in/email', body: json({}), contentType: 'application/json' }, noSession)).toBeNull()
    expect(await guardAuthRequest({ method: 'GET', path: '/oauth2/authorize', body: undefined, contentType: null }, noSession)).toBeNull()
  })
})

describe('default resource', () => {
  const url = new URL('https://hub.example.com/secret0000000/api/auth/oauth2/authorize?client_id=c')

  it('adds resource to authorize when missing and keeps an explicit one', () => {
    const added = withDefaultResource({ method: 'GET', path: '/oauth2/authorize', url, body: undefined, contentType: null }, RESOURCE)
    expect(added.url.searchParams.get('resource')).toBe(RESOURCE)

    const explicit = new URL(url)
    explicit.searchParams.set('resource', 'https://other.example.com/mcp')
    const kept = withDefaultResource({ method: 'GET', path: '/oauth2/authorize', url: explicit, body: undefined, contentType: null }, RESOURCE)
    expect(kept.url.searchParams.get('resource')).toBe('https://other.example.com/mcp')
  })

  it('adds the hub scope when a client asks for other scopes only', () => {
    const asked = new URL(url)
    asked.searchParams.set('scope', 'openid offline_access')
    const r = withDefaultResource({ method: 'GET', path: '/oauth2/authorize', url: asked, body: undefined, contentType: null }, RESOURCE)
    expect(r.url.searchParams.get('scope')).toBe('openid offline_access hub')
    const already = new URL(url)
    already.searchParams.set('scope', 'hub offline_access')
    expect(withDefaultResource({ method: 'GET', path: '/oauth2/authorize', url: already, body: undefined, contentType: null }, RESOURCE).url.searchParams.get('scope')).toBe('hub offline_access')
    // No scope at all: better-auth uses the client's registered scopes, which include hub.
    expect(withDefaultResource({ method: 'GET', path: '/oauth2/authorize', url, body: undefined, contentType: null }, RESOURCE).url.searchParams.has('scope')).toBe(false)
  })

  it('adds resource to form-encoded token requests', () => {
    const form = 'application/x-www-form-urlencoded'
    const { body } = withDefaultResource(
      { method: 'POST', path: '/oauth2/token', url, body: enc('grant_type=authorization_code&code=x'), contentType: form },
      RESOURCE,
    )
    expect(new URLSearchParams(new TextDecoder().decode(body)).get('resource')).toBe(RESOURCE)

    const other = withDefaultResource(
      { method: 'POST', path: '/oauth2/token', url, body: enc('grant_type=client_credentials'), contentType: form },
      RESOURCE,
    )
    expect(new URLSearchParams(new TextDecoder().decode(other.body)).has('resource')).toBe(false)
  })
})
