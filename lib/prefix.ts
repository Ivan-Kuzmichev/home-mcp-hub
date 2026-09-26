import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getDb } from './db'
import { setting } from './db/schema'

export const PREFIX_SETTING_KEY = 'mcp_path_secret'
export const PREFIX_PATTERN = /^[0-9A-Za-z]{12,32}$/

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function generatePrefix(length = 14): string {
  let out = ''
  for (let i = 0; i < length; i++) out += BASE62[randomInt(BASE62.length)]
  return out
}

/** Constant-time comparison; hashing first makes the comparison independent of length. */
export function prefixMatches(candidate: string, prefix: string): boolean {
  const a = createHash('sha256').update(candidate).digest()
  const b = createHash('sha256').update(prefix).digest()
  return timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Storage. The cache lives on globalThis so middleware, route handlers and
// instrumentation (separate bundles in one process) see the same value.

const CACHE_TTL_MS = 10_000
const globalForPrefix = globalThis as unknown as { __hubPrefix?: { value: string | null; at: number } }

export function readPrefix(): string | null {
  const cached = globalForPrefix.__hubPrefix
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  const row = getDb().select().from(setting).where(eq(setting.key, PREFIX_SETTING_KEY)).get()
  const value = row?.value ?? null
  globalForPrefix.__hubPrefix = { value, at: Date.now() }
  return value
}

export function getPrefix(): string {
  const prefix = readPrefix()
  if (!prefix) throw new Error('Path prefix is not initialised')
  return prefix
}

export function savePrefix(value: string): void {
  if (!PREFIX_PATTERN.test(value)) throw new Error('Prefix must be 12–32 base62 characters')
  getDb()
    .insert(setting)
    .values({ key: PREFIX_SETTING_KEY, value })
    .onConflictDoUpdate({ target: setting.key, set: { value } })
    .run()
  globalForPrefix.__hubPrefix = { value, at: Date.now() }
}

/** Build an in-app URL with the secret prefix: href('/admin') → '/{secret}/admin'. */
export function href(path: string, prefix: string = getPrefix()): string {
  return withPrefix(prefix, path)
}

export function withPrefix(prefix: string, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`
  return clean === '/' ? `/${prefix}` : `/${prefix}${clean}`
}

// ---------------------------------------------------------------------------
// Routing decision used by middleware.ts. Pure, so it is easy to test.

export type RouteDecision =
  | { type: 'pass' }
  | { type: 'rewrite'; pathname: string }
  | { type: 'notFound' }

const WELL_KNOWN_WITH_SUFFIX = ['oauth-authorization-server', 'openid-configuration']

export function decideRoute(pathname: string, prefix: string | null, opts: { dev?: boolean } = {}): RouteDecision {
  // Prototypes live outside the prefix: their links are shared and survive a prefix change.
  if (pathname === '/p' || pathname.startsWith('/p/')) return { type: 'pass' }
  // Document download links (Paperless): random token, shared without revealing the prefix.
  if (pathname.startsWith('/f/')) return { type: 'pass' }
  // Hashed build assets are not guessable. In dev Next also needs HMR and friends.
  if (pathname.startsWith('/_next/static/')) return { type: 'pass' }
  if (opts.dev && (pathname.startsWith('/_next/') || pathname.startsWith('/__nextjs'))) return { type: 'pass' }

  if (!prefix) return { type: 'notFound' }

  const segments = pathname.split('/')
  // segments[0] is '' because pathname starts with '/'
  const first = segments[1] ?? ''

  // RFC 8414 / OIDC path-insert: /.well-known/<name>/{secret}
  if (first === '.well-known') {
    const name = segments[2] ?? ''
    const rest = segments[3] ?? ''
    if (WELL_KNOWN_WITH_SUFFIX.includes(name) && segments.length === 4 && prefixMatches(rest, prefix)) {
      return { type: 'pass' }
    }
    return { type: 'notFound' }
  }

  if (!first || !prefixMatches(first, prefix)) return { type: 'notFound' }

  // /{secret}/.well-known/* is served by app/[secret]/.well-known routes as is.
  if (segments[2] === '.well-known') return { type: 'pass' }

  const internal = '/' + segments.slice(2).join('/')
  // Internal route namespaces must not be reachable twice (e.g. /{secret}/p/x).
  if (internal === '/p' || internal.startsWith('/p/') || internal.startsWith('/f/')) return { type: 'notFound' }
  return { type: 'rewrite', pathname: internal }
}
