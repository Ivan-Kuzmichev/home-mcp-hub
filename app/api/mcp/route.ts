import { requireMcpAuth } from '@better-auth/mcp'
import { eq } from 'drizzle-orm'
import type { JWTPayload } from 'jose'
import { getAuth, hubUrls, isMcpAvailable, MCP_SCOPE } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { oauthClient } from '@/lib/db/schema'
import { BodyError, decodeRequestBody, logUnparsableBody } from '@/lib/mcp/body'
import { mcpContext } from '@/lib/mcp/context'
import { getMcpHandler } from '@/lib/mcp/server'
import { clientIp, ipInCidr } from '@/lib/net'
import { logger } from '@/lib/logger'
import { SlidingWindow } from '@/lib/rate-limit'
import { getAllowedCidrs } from '@/lib/settings'

export const dynamic = 'force-dynamic'

function clientIdOf(claims: JWTPayload): string | null {
  return typeof claims.azp === 'string' ? claims.azp : typeof claims.client_id === 'string' ? claims.client_id : null
}

/** Tokens are JWTs; deleting or disabling the client in the admin panel revokes them at once. */
function clientIsActive(claims: JWTPayload): boolean {
  const clientId = clientIdOf(claims)
  if (!clientId) return false
  const client = getDb().select({ disabled: oauthClient.disabled }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).get()
  return !!client && !client.disabled
}

function unauthorized(resourceMetadata: string): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null },
    { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadata}", scope="${MCP_SCOPE}"` } },
  )
}

const MCP_CALLS_PER_MINUTE = 60
const globalForLimit = globalThis as unknown as { __hubMcpLimit?: SlidingWindow }
const limiter = (globalForLimit.__hubMcpLimit ??= new SlidingWindow(MCP_CALLS_PER_MINUTE, 60_000))

function tooMany(retryAfterSec: number): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32000, message: `Rate limit: ${MCP_CALLS_PER_MINUTE} requests per minute` }, id: null },
    { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
  )
}

async function serve(req: Request, claims: JWTPayload, ip: string, resourceMetadata: string): Promise<Response> {
  if (!clientIsActive(claims)) return unauthorized(resourceMetadata)
  const clientId = clientIdOf(claims)
  const limit = limiter.hit(clientId ?? ip)
  if (!limit.allowed) {
    logger.warn({ retryAfter: limit.retryAfterSec }, 'mcp rate limit hit')
    return tooMany(limit.retryAfterSec)
  }
  let decoded: Awaited<ReturnType<typeof decodeRequestBody>>
  try {
    decoded = await decodeRequestBody(req)
  } catch (error) {
    const message = error instanceof BodyError ? error.message : 'Cannot decode request body'
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'mcp request body decode failed')
    return Response.json({ jsonrpc: '2.0', error: { code: -32700, message: `Parse error: ${message}` }, id: null }, { status: 400 })
  }
  const response = await mcpContext.run({ clientId, ip }, () => getMcpHandler()(decoded.request))
  if (response.status === 400) logUnparsableBody(req, decoded)
  return response
}

export async function POST(request: Request): Promise<Response> {
  if (!isMcpAvailable()) return new Response('MCP requires an https BASE_URL', { status: 503 })

  // Optional allow-list («разрешённые CIDR» on the access screen), checked before OAuth.
  const ip = clientIp(request.headers)
  const cidrs = getAllowedCidrs()
  if (cidrs.length && !cidrs.some((c) => ipInCidr(ip, c))) {
    logger.warn({ ip, allowed: cidrs, userAgent: request.headers.get('user-agent')?.slice(0, 80) }, 'mcp 403: IP is not in the allowed CIDR list')
    return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden' }, id: null }, { status: 403 })
  }

  const urls = hubUrls()
  const protectedHandler = requireMcpAuth(
    getAuth(),
    (req, claims) => serve(req, claims, ip, urls.resourceMetadata),
    { issuer: urls.issuer, resource: urls.resource, jwksUrl: urls.jwksLoopback, requiredScopes: [MCP_SCOPE] },
  )
  const response = await protectedHandler(request)
  if (response.status === 401 || response.status === 403) {
    // Say why a client is refused: token missing, invalid, or without the hub scope.
    const challenge = response.headers.get('WWW-Authenticate') ?? ''
    const reason = /error="([^"]+)"/.exec(challenge)?.[1] ?? (request.headers.has('authorization') ? 'invalid_token' : 'no_token')
    const level = response.status === 403 || reason !== 'no_token' ? 'warn' : 'debug'
    logger[level]({ status: response.status, reason, ip, userAgent: request.headers.get('user-agent')?.slice(0, 80) }, `mcp ${response.status}: ${reason}`)
  }

  // The library points resource_metadata at the RFC 9728 path-insert address under the
  // root /.well-known, which the hub does not serve; use the prefixed address instead.
  const challenge = response.headers.get('WWW-Authenticate')
  if (challenge?.includes('resource_metadata=')) {
    const headers = new Headers(response.headers)
    headers.set('WWW-Authenticate', challenge.replace(/resource_metadata="[^"]*"/, `resource_metadata="${urls.resourceMetadata}"`))
    return new Response(response.body, { status: response.status, headers })
  }
  return response
}
