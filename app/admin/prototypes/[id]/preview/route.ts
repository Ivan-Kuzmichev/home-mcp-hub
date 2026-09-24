import { headers } from 'next/headers'
import { getAuth } from '@/lib/auth'
import { PROTOTYPE_CSP, PUBLIC_HEADERS } from '@/lib/prototypes/http'
import { getById, readHtml } from '@/lib/prototypes/store'

export const dynamic = 'force-dynamic'

/** Admin preview of any version, bypassing the pin; same sandbox as the public page. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (!session?.user.twoFactorEnabled) return new Response(null, { status: 404 })
  const { id } = await params
  const p = getById(id)
  const v = Number(new URL(req.url).searchParams.get('v') ?? p?.version)
  const html = p ? readHtml(p, Number.isInteger(v) ? v : p.version) : null
  if (html === null) return new Response(null, { status: 404 })
  return new Response(html, {
    headers: { ...PUBLIC_HEADERS, 'Content-Type': 'text/html; charset=utf-8', // Framed by the admin card on the same origin only.
      'Content-Security-Policy': `${PROTOTYPE_CSP}; frame-ancestors 'self'`, 'Cache-Control': 'no-store' },
  })
}
