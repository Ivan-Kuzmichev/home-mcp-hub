import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-guard-'))
process.env.DATABASE_PATH = path.join(tmp, 'hub.db')

const { guardAuthRequest, withDefaultResource } = await import('@/lib/oauth-guard')
const { setDcrAllowed } = await import('@/lib/settings')
const { getDb } = await import('@/lib/db')

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

beforeAll(() => {
  getDb().run('CREATE TABLE IF NOT EXISTS setting (key text PRIMARY KEY NOT NULL, value text NOT NULL)')
})

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('client registration', () => {
  it('is refused while allow_dcr is off', async () => {
    setDcrAllowed(false)
    const res = await register([CLAUDE])
    expect(res?.status).toBe(403)
    expect(await res?.json()).toMatchObject({ error: 'access_denied' })
  })

  it('accepts only the Claude redirect URI when allow_dcr is on', async () => {
    setDcrAllowed(true)
    expect(await register([CLAUDE])).toBeNull()
    expect((await register(['https://evil.example.com/cb']))?.status).toBe(400)
    expect((await register([CLAUDE, 'https://evil.example.com/cb']))?.status).toBe(400)
    expect((await register([]))?.status).toBe(400)
    expect((await register('https://claude.ai/api/mcp/auth_callback'))?.status).toBe(400)
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
