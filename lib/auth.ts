import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { twoFactor } from 'better-auth/plugins'
import { getDb, schema } from './db'
import { env } from './env'
import { getPrefix } from './prefix'

export const AUTH_BASE_PATH = '/api/auth'

function createAuth(prefix: string) {
  const e = env()
  const publicBase = `${e.BASE_URL}/${prefix}`
  return betterAuth({
    appName: 'Home Hub',
    // Full URL including the secret prefix: better-auth uses it for its router,
    // redirects and (from stage 2) OAuth metadata.
    baseURL: `${publicBase}${AUTH_BASE_PATH}`,
    secret: e.BETTER_AUTH_SECRET,
    trustedOrigins: [e.BASE_URL],
    database: drizzleAdapter(getDb(), { provider: 'sqlite', schema }),
    emailAndPassword: {
      enabled: true,
      // The single admin is created from ADMIN_EMAIL / ADMIN_PASSWORD on first start.
      disableSignUp: true,
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 15 * 60, max: 5 },
      },
    },
    advanced: {
      ipAddress: e.TRUST_PROXY ? { ipAddressHeaders: ['x-forwarded-for'] } : undefined,
    },
    plugins: [
      twoFactor({
        issuer: 'Home Hub',
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 15 * 60 },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

const globalForAuth = globalThis as unknown as { __hubAuth?: { prefix: string; auth: Auth } }

/** better-auth instance for the current prefix; recreated when the prefix changes. */
export function getAuth(): Auth {
  const prefix = getPrefix()
  const cached = globalForAuth.__hubAuth
  if (cached && cached.prefix === prefix) return cached.auth
  const auth = createAuth(prefix)
  globalForAuth.__hubAuth = { prefix, auth }
  return auth
}

/**
 * Middleware rewrites /{secret}/api/auth/* to /api/auth/*. better-auth routes by the
 * public path from baseURL, so hand it the request with the prefix restored.
 */
export async function toPublicAuthRequest(request: Request, prefix: string = getPrefix()): Promise<Request> {
  const url = new URL(request.url)
  if (url.pathname !== AUTH_BASE_PATH && !url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) return request
  url.pathname = `/${prefix}${url.pathname}`
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    signal: request.signal,
  })
}
