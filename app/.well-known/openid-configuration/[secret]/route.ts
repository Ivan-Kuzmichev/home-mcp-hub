import { authorizationServerMetadata } from '@/lib/oauth-metadata'

export const dynamic = 'force-dynamic'

export function GET(_req: Request, { params }: { params: Promise<{ secret: string }> }) {
  return authorizationServerMetadata(params)
}
