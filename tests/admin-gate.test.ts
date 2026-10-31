import { afterAll, describe, expect, it } from 'vitest'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
process.env.BETTER_AUTH_SECRET = 's'.repeat(40)
process.env.BASE_URL = 'https://hub.example.com'

const { savePrefix } = await import('@/lib/prefix')
savePrefix('gfgsfv2rfdAbc123')
const { getAuth } = await import('@/lib/auth')
const { hasAdminSession } = await import('@/lib/session')
const { getDb } = await import('@/lib/db')
const { user } = await import('@/lib/db/auth-schema')

afterAll(cleanup)

const EMAIL = 'admin@example.com'
const PASSWORD = 'correct horse battery'

/** Admin as bootstrap creates it, signed in with a real better-auth session cookie. */
async function signedInCookie(): Promise<string> {
  const ctx = await getAuth().$context
  const created = await ctx.internalAdapter.createUser({ email: EMAIL, name: 'admin', emailVerified: true }, { method: 'email-password' })
  await ctx.internalAdapter.linkAccount({ userId: created.id, providerId: 'credential', accountId: created.id, password: await ctx.password.hash(PASSWORD) })
  const res = await getAuth().api.signInEmail({ body: { email: EMAIL, password: PASSWORD }, asResponse: true })
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  expect(cookies).not.toBe('')
  return cookies
}

describe('admin gate session check', () => {
  it('lets the signed-in admin with 2FA through and refuses everyone else', async () => {
    const cookie = await signedInCookie()
    expect(await hasAdminSession(new Headers())).toBe(false)
    // Signed in but 2FA not set up yet: the admin panel is still closed.
    expect(await hasAdminSession(new Headers({ cookie }))).toBe(false)

    getDb().update(user).set({ twoFactorEnabled: true }).run()
    expect(await hasAdminSession(new Headers({ cookie }))).toBe(true)
    expect(await hasAdminSession(new Headers({ cookie: cookie.replace(/=[^;]+/, '=forged') }))).toBe(false)
  })
})
