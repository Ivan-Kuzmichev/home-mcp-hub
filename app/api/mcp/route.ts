import { requireMcpAuth } from '@better-auth/mcp'
import { eq } from 'drizzle-orm'
import type { JWTPayload } from 'jose'
import { getAuth, hubUrls, isMcpAvailable, MCP_SCOPE } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { oauthClient } from '@/lib/db/schema'
import { getMcpHandler } from '@/lib/mcp/server'

export const dynamic = 'force-dynamic'

/** Tokens are JWTs; deleting or disabling the client in the admin panel revokes them at once. */
function clientIsActive(claims: JWTPayload): boolean {
  const clientId = typeof claims.azp === 'string' ? claims.azp : typeof claims.client_id === 'string' ? claims.client_id : null
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

export async function POST(request: Request): Promise<Response> {
  if (!isMcpAvailable()) return new Response('MCP requires an https BASE_URL', { status: 503 })

  const urls = hubUrls()
  const protectedHandler = requireMcpAuth(
    getAuth(),
    async (req, claims) => (clientIsActive(claims) ? getMcpHandler()(req) : unauthorized(urls.resourceMetadata)),
    { issuer: urls.issuer, resource: urls.resource, jwksUrl: urls.jwksLoopback, requiredScopes: [MCP_SCOPE] },
  )
  const response = await protectedHandler(request)

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
