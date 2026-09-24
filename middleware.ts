import { NextResponse, type NextRequest } from 'next/server'
import { decideRoute, readPrefix } from '@/lib/prefix'

export const config = {
  // Node runtime: the prefix lives in SQLite and is compared with node:crypto.
  runtime: 'nodejs',
  matcher: '/:path*',
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

function emptyNotFound(): NextResponse {
  return new NextResponse(null, { status: 404, headers: SECURITY_HEADERS })
}

export function middleware(request: NextRequest): NextResponse {
  let prefix: string | null
  try {
    prefix = readPrefix()
  } catch {
    prefix = null
  }

  const decision = decideRoute(request.nextUrl.pathname, prefix, { dev: process.env.NODE_ENV === 'development' })

  let response: NextResponse
  switch (decision.type) {
    case 'notFound':
      return emptyNotFound()
    case 'pass':
      response = NextResponse.next()
      break
    case 'rewrite': {
      const url = request.nextUrl.clone()
      url.pathname = decision.pathname
      response = NextResponse.rewrite(url)
      break
    }
  }
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v)
  // Prototypes and pin pages are shared by link, never indexed.
  if (request.nextUrl.pathname.startsWith('/p/')) response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  return response
}
