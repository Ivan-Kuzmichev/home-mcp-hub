import { CLAUDE_REDIRECT_URI } from './auth'
import { isDcrAllowed } from './settings'

type GuardInput = {
  method: string
  /** Path inside better-auth, e.g. /oauth2/register */
  path: string
  body: ArrayBuffer | undefined
  contentType: string | null
}

type Session = { user: { twoFactorEnabled?: boolean | null } } | null

// Client management endpoints the hub never uses: clients appear only via DCR from Claude.
const BLOCKED_PATHS = ['/oauth2/create-client', '/oauth2/update-client', '/oauth2/client/rotate-secret']

function oauthError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status, headers: { 'Cache-Control': 'no-store' } })
}

function parseBody(body: ArrayBuffer | undefined, contentType: string | null): Record<string, unknown> | null {
  if (!body || body.byteLength === 0) return {}
  const text = new TextDecoder().decode(body)
  try {
    if (contentType?.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text))
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Hub-level policy in front of better-auth. Returns a response to short-circuit the
 * request, or null to let better-auth handle it.
 */
export async function guardAuthRequest(input: GuardInput, getSession: () => Promise<Session>): Promise<Response | null> {
  const { method, path } = input

  if (path.startsWith('/admin/') || BLOCKED_PATHS.includes(path)) {
    return new Response(null, { status: 404 })
  }

  if (path === '/oauth2/register' && method === 'POST') {
    if (!isDcrAllowed()) {
      return oauthError(403, 'access_denied', 'Client registration is disabled. Enable it in the hub admin panel.')
    }
    const body = parseBody(input.body, input.contentType)
    const uris = body?.redirect_uris
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => u === CLAUDE_REDIRECT_URI)) {
      return oauthError(400, 'invalid_redirect_uri', `Only ${CLAUDE_REDIRECT_URI} is allowed`)
    }
    return null
  }

  // Granting consent issues tokens to Claude: require a session that completed 2FA.
  if (path === '/oauth2/consent' && method === 'POST') {
    const session = await getSession()
    if (!session?.user.twoFactorEnabled) return oauthError(403, 'access_denied', 'Two-factor authentication required')
  }

  return null
}

/**
 * The hub has exactly one protected resource. Without an RFC 8707 `resource` parameter
 * better-auth issues an opaque token with no audience, which /api/mcp rejects. MCP
 * clients should send it, but default it so a client that does not still ends up
 * with a JWT bound to /{secret}/api/mcp.
 */
export function withDefaultResource(
  input: { method: string; path: string; url: URL; body: ArrayBuffer | undefined; contentType: string | null },
  resource: string,
): { url: URL; body: ArrayBuffer | undefined } {
  const { method, path, url, body, contentType } = input

  if (path === '/oauth2/authorize' && method === 'GET' && !url.searchParams.has('resource')) {
    const next = new URL(url)
    next.searchParams.set('resource', resource)
    return { url: next, body }
  }

  if (path === '/oauth2/token' && method === 'POST' && contentType?.includes('application/x-www-form-urlencoded') && body) {
    const params = new URLSearchParams(new TextDecoder().decode(body))
    const grant = params.get('grant_type')
    if ((grant === 'authorization_code' || grant === 'refresh_token') && !params.has('resource')) {
      params.set('resource', resource)
      return { url, body: new TextEncoder().encode(params.toString()).buffer as ArrayBuffer }
    }
  }

  return { url, body }
}
