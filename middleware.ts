import { NextResponse, type NextRequest } from 'next/server'
import { decideRoute, readPrefix, withPrefix } from '@/lib/prefix'
import { hasAdminSession } from '@/lib/session'

export const config = {
  // Node runtime: the prefix lives in SQLite and is compared with node:crypto.
  runtime: 'nodejs',
  matcher: '/:path*',
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

function baseHeaders(): Record<string, string> {
  // HSTS only over https; no includeSubDomains — other services may share the domain.
  return process.env.BASE_URL?.startsWith('https://') ? { ...SECURITY_HEADERS, 'Strict-Transport-Security': 'max-age=31536000' } : SECURITY_HEADERS
}

/** CSP for pages rendered by Next.js: no inline scripts except Next's own, which carry the nonce. */
export function pageCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // React style attributes need inline styles; scripts stay locked down.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    // Prototype previews are same-origin iframes.
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

/** Which responses are Next.js pages (get the nonce CSP) rather than API, files or prototype HTML. */
export function isPagePath(internalPath: string): boolean {
  if (internalPath.startsWith('/api/') || internalPath.startsWith('/.well-known') || internalPath.includes('/.well-known/')) return false
  if (/^\/admin\/prototypes\/[^/]+\/preview$/.test(internalPath) || internalPath === '/admin/activity/export') return false
  if (internalPath.startsWith('/brand/') || internalPath.startsWith('/f/')) return false
  if (internalPath.startsWith('/p/')) return /^\/p\/[^/]+\/pin$/.test(internalPath)
  return true
}

function emptyNotFound(): NextResponse {
  return new NextResponse(null, { status: 404, headers: baseHeaders() })
}

/**
 * Admin pages are gated here, before anything renders. A redirect() in the admin layout is not enough:
 * Next renders the layout and the page in parallel, so the page's data was streamed into the body of
 * the 307 response to anyone who knew the prefix. Route handlers under /admin check the session themselves.
 */
export function isAdminPath(internalPath: string): boolean {
  return internalPath === '/admin' || internalPath.startsWith('/admin/')
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  let prefix: string | null
  try {
    prefix = readPrefix()
  } catch {
    prefix = null
  }

  const dev = process.env.NODE_ENV === 'development'
  const pathname = request.nextUrl.pathname
  const decision = decideRoute(pathname, prefix, { dev })
  if (decision.type === 'notFound') return emptyNotFound()

  const internalPath = decision.type === 'rewrite' ? decision.pathname : pathname
  if (prefix && decision.type === 'rewrite' && isAdminPath(internalPath) && !(await hasAdminSession(request.headers))) {
    // Next requires an absolute Location from middleware.
    const res = NextResponse.redirect(new URL(withPrefix(prefix, '/login'), request.nextUrl), 307)
    for (const [k, v] of Object.entries(baseHeaders())) res.headers.set(k, v)
    res.headers.set('Cache-Control', 'no-store')
    return res
  }
  const page = !pathname.startsWith('/_next/') && isPagePath(internalPath)

  // Pages: hand the nonce to Next.js through the request CSP header.
  const requestHeaders = new Headers(request.headers)
  let csp: string | null = null
  if (page) {
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
    csp = pageCsp(nonce, dev)
    requestHeaders.set('x-nonce', nonce)
    requestHeaders.set('content-security-policy', csp)
  }

  let response: NextResponse
  if (decision.type === 'rewrite') {
    const url = request.nextUrl.clone()
    url.pathname = decision.pathname
    response = NextResponse.rewrite(url, { request: { headers: requestHeaders } })
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } })
  }

  for (const [k, v] of Object.entries(baseHeaders())) response.headers.set(k, v)
  if (csp) response.headers.set('Content-Security-Policy', csp)
  // Prototypes and pin pages are shared by link, never indexed.
  if (pathname.startsWith('/p/') || pathname.startsWith('/f/')) response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  return response
}
