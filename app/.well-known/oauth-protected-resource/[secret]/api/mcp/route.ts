import { protectedResourceMetadata } from '@/lib/oauth-metadata'

export const dynamic = 'force-dynamic'

/** RFC 9728 path-insert address of the resource metadata, for clients that derive it from the MCP URL. */
export function GET(_req: Request, { params }: { params: Promise<{ secret: string }> }) {
  return protectedResourceMetadata(params)
}
