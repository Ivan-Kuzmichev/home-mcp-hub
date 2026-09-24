import { authSubpath, getAuth, hubUrls, isMcpAvailable, toPublicAuthRequest } from '@/lib/auth'
import { recordAuthEvent } from '@/lib/auth-events'
import { clientIp } from '@/lib/net'
import { guardAuthRequest, withDefaultResource } from '@/lib/oauth-guard'

export const dynamic = 'force-dynamic'

async function handle(request: Request): Promise<Response> {
  const auth = getAuth()
  const path = authSubpath(request)
  const contentType = request.headers.get('content-type')
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  let body = hasBody ? await request.arrayBuffer() : undefined

  const blocked = await guardAuthRequest({ method: request.method, path, body, contentType }, () =>
    auth.api.getSession({ headers: request.headers }),
  )
  if (blocked) return blocked

  let url = new URL(request.url)
  if (isMcpAvailable()) {
    ;({ url, body } = withDefaultResource({ method: request.method, path, url, body, contentType }, hubUrls().resource))
  }

  const originalBody = body
  const response = await auth.handler(toPublicAuthRequest(new Request(url, { method: request.method, headers: request.headers }), body))
  await recordAuthEvent({ method: request.method, path, body: originalBody, response, ip: clientIp(request.headers) })
  return response
}

export { handle as GET, handle as POST }
