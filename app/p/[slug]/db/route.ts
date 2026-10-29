import { verifyDataToken } from '@/lib/prototypes/access'
import { DataConflictError, MAX_DATA_BYTES, readData, writeData } from '@/lib/prototypes/data'
import { PUBLIC_HEADERS, SLUG_PATTERN } from '@/lib/prototypes/http'
import { getBySlug, isExpired, PrototypeError, type Prototype } from '@/lib/prototypes/store'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ slug: string }> }

// The page runs in an opaque origin (Origin: null), so every call is cross-origin.
// No cookies are involved: access is the bearer token embedded into the served HTML.
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '600',
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...PUBLIC_HEADERS, ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  })
}

async function authorize(req: Request, ctx: Ctx): Promise<Prototype | Response> {
  const { slug } = await ctx.params
  const p = SLUG_PATTERN.test(slug) ? getBySlug(slug) : undefined
  if (!p || p.version === 0) return json(404, { error: 'not found' })
  if (isExpired(p)) return json(410, { error: 'expired' })
  const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
  if (!verifyDataToken(token, p)) return json(401, { error: 'access expired, reload the page' })
  return p
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS })
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const p = await authorize(req, ctx)
  if (p instanceof Response) return p
  const { rev, data } = readData(p)
  return json(200, data, { ETag: `"${rev}"` })
}

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
  const p = await authorize(req, ctx)
  if (p instanceof Response) return p
  const text = await req.text()
  if (Buffer.byteLength(text) > MAX_DATA_BYTES) return json(413, { error: `data over ${MAX_DATA_BYTES / 1024 / 1024} MB` })
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return json(400, { error: 'body must be JSON' })
  }
  const ifMatch = req.headers.get('if-match')
  const ifRev = ifMatch ? Number(ifMatch.replace(/"/g, '')) : undefined
  if (ifRev !== undefined && !Number.isInteger(ifRev)) return json(400, { error: 'bad If-Match' })
  try {
    const rev = writeData(p, data, ifRev)
    return json(200, { rev }, { ETag: `"${rev}"` })
  } catch (e) {
    if (e instanceof DataConflictError) return json(409, { error: 'conflict' })
    if (e instanceof PrototypeError) return json(413, { error: e.message })
    throw e
  }
}
