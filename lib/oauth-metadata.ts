import { getAuth, hubUrls, MCP_SCOPE } from './auth'
import { getPrefix, prefixMatches } from './prefix'

const HEADERS = {
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
}

function notFound(): Response {
  return new Response(null, { status: 404 })
}

/** Route params come from a dynamic segment; only the real prefix gets an answer. */
async function secretMatches(params: Promise<{ secret: string }>): Promise<boolean> {
  const { secret } = await params
  return prefixMatches(secret, getPrefix())
}

/** RFC 9728 protected resource metadata; the 401 from /api/mcp points here. */
export async function protectedResourceMetadata(params: Promise<{ secret: string }>): Promise<Response> {
  if (!(await secretMatches(params))) return notFound()
  const urls = hubUrls()
  return Response.json(
    {
      resource: urls.resource,
      authorization_servers: [urls.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [MCP_SCOPE],
      resource_name: 'Home Hub',
    },
    { headers: HEADERS },
  )
}

/**
 * Authorization server metadata. The issuer has a path, so the MCP spec has clients
 * try three addresses; all of them get the same document (OIDC config is a superset
 * of RFC 8414 metadata).
 */
export async function authorizationServerMetadata(params: Promise<{ secret: string }>): Promise<Response> {
  if (!(await secretMatches(params))) return notFound()
  const metadata = await getAuth().api.getOpenIdConfig()
  return Response.json(metadata, { headers: HEADERS })
}
