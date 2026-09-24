import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { jwt, twoFactor } from 'better-auth/plugins'
import { mcp } from '@better-auth/mcp'
import { getDb, schema } from './db'
import { env } from './env'
import { logger } from './logger'
import { getPrefix, withPrefix } from './prefix'

export const AUTH_BASE_PATH = '/api/auth'
export const MCP_PATH = '/api/mcp'
export const MCP_SCOPE = 'hub'
export const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'
export const ACCESS_TOKEN_TTL = 60 * 60
export const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30

export type HubUrls = {
  /** https://hub.example.com/{secret} — also the OAuth issuer */
  issuer: string
  /** https://hub.example.com/{secret}/api/auth — better-auth baseURL */
  authBase: string
  /** https://hub.example.com/{secret}/api/mcp — protected resource, token audience */
  resource: string
  /** https://hub.example.com/{secret}/.well-known/oauth-protected-resource */
  resourceMetadata: string
  /** JWKS over loopback, so the hub does not call itself through Pangolin */
  jwksLoopback: string
}

export function hubUrls(prefix: string = getPrefix()): HubUrls {
  const base = env().BASE_URL
  const issuer = `${base}/${prefix}`
  const port = process.env.PORT ?? '3000'
  return {
    issuer,
    authBase: `${issuer}${AUTH_BASE_PATH}`,
    resource: `${issuer}${MCP_PATH}`,
    resourceMetadata: `${issuer}/.well-known/oauth-protected-resource`,
    jwksLoopback: `http://127.0.0.1:${port}/${prefix}${AUTH_BASE_PATH}/jwks`,
  }
}

/** Claude requires HTTPS; @better-auth/mcp only accepts plain http on loopback (local dev). */
export function isMcpAvailable(): boolean {
  const url = new URL(env().BASE_URL)
  if (url.protocol === 'https:') return true
  return url.hostname === 'localhost' || url.hostname.startsWith('127.') || url.hostname === '[::1]'
}

function createAuth(prefix: string) {
  const e = env()
  const urls = hubUrls(prefix)
  // On a plain-http LAN test the MCP resource is invalid for the plugin; keep the admin
  // working with a placeholder and let /api/mcp answer 503 (see isMcpAvailable).
  const resource = isMcpAvailable() ? urls.resource : `https://mcp-disabled.invalid/${prefix}${MCP_PATH}`

  return betterAuth({
    appName: 'Home Hub',
    // Full URL including the secret prefix: better-auth uses it for its router,
    // redirects and OAuth metadata endpoints.
    baseURL: urls.authBase,
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
      // Signs access tokens; the issuer is the prefixed hub URL, not the auth base path,
      // so RFC 8414 metadata lives at /.well-known/oauth-authorization-server/{secret}.
      jwt({ jwt: { issuer: urls.issuer } }),
      mcp({
        resource,
        loginPage: withPrefix(prefix, '/login'),
        consentPage: withPrefix(prefix, '/consent'),
        scopes: ['openid', 'offline_access', MCP_SCOPE],
        // DCR is on at the library level; lib/oauth-guard.ts gates it by the allow_dcr
        // setting and restricts redirect URIs to Claude's callback.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        accessTokenExpiresIn: ACCESS_TOKEN_TTL,
        refreshTokenExpiresIn: REFRESH_TOKEN_TTL,
        grantTypes: ['authorization_code', 'refresh_token'],
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
  if (!isMcpAvailable()) logger.warn('BASE_URL is plain http on a non-loopback host: MCP endpoint is disabled')
  const auth = createAuth(prefix)
  globalForAuth.__hubAuth = { prefix, auth }
  return auth
}

/**
 * Middleware rewrites /{secret}/api/auth/* to /api/auth/*. better-auth routes by the
 * public path from baseURL, so hand it the request with the prefix restored.
 */
export function toPublicAuthRequest(request: Request, body: ArrayBuffer | undefined, prefix: string = getPrefix()): Request {
  const url = new URL(request.url)
  if (url.pathname === AUTH_BASE_PATH || url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
    url.pathname = `/${prefix}${url.pathname}`
  }
  const headers = new Headers(request.headers)
  // The body may have been rewritten (see withDefaultResource); let fetch recompute the length.
  headers.delete('content-length')
  return new Request(url, { method: request.method, headers, body })
}

/** Path inside better-auth: /api/auth/oauth2/register → /oauth2/register (with or without prefix). */
export function authSubpath(request: Request, prefix: string = getPrefix()): string {
  let path = new URL(request.url).pathname
  if (path.startsWith(`/${prefix}/`)) path = path.slice(prefix.length + 1)
  return path.startsWith(AUTH_BASE_PATH) ? path.slice(AUTH_BASE_PATH.length) || '/' : path
}
