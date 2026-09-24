import { getAuth, toPublicAuthRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

async function handle(request: Request): Promise<Response> {
  return getAuth().handler(await toPublicAuthRequest(request))
}

export { handle as GET, handle as POST }
