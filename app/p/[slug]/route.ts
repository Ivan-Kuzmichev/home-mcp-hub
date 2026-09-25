import { cookies } from 'next/headers'
import {
  accessCookieName,
  ACCESS_TTL_MS,
  attemptState,
  clearAttempts,
  clientIp,
  recordFailedAttempt,
  signAccess,
  verifyAccess,
} from '@/lib/prototypes/access'
import { PROTOTYPE_CSP, PUBLIC_HEADERS, SLUG_PATTERN, simplePage } from '@/lib/prototypes/http'
import { getBySlug, isExpired, readHtml, recordView, verifyPin } from '@/lib/prototypes/store'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ slug: string }> }

function notFound(): Response {
  return simplePage(404, 'Прототип не найден', 'Ссылка неверная или прототип удалён.')
}

function gone(): Response {
  return simplePage(410, 'Срок истёк', 'Этот прототип больше недоступен. Попроси прислать новую ссылку.')
}

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  const { slug } = await params
  if (!SLUG_PATTERN.test(slug)) return notFound()
  const p = getBySlug(slug)
  if (!p) return notFound()
  if (isExpired(p)) return gone()
  // Chunked upload still in progress.
  if (p.version === 0) return simplePage(404, 'Страница ещё загружается', 'Прототип публикуется по частям. Обнови страницу через минуту.')

  if (p.pinHash) {
    const cookie = (await cookies()).get(accessCookieName(slug))?.value
    if (!verifyAccess(cookie, p)) {
      return new Response(null, { status: 303, headers: { ...PUBLIC_HEADERS, Location: `/p/${slug}/pin`, 'Cache-Control': 'no-store' } })
    }
  }

  const html = readHtml(p)
  if (html === null) return notFound()
  recordView(p)
  return new Response(html, {
    headers: {
      ...PUBLIC_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PROTOTYPE_CSP,
      'Cache-Control': p.pinHash ? 'private, no-store' : 'no-cache',
    },
  })
}

/** Pin check: 200 + access cookie, 401 with remaining attempts, 429 when locked. */
export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  const { slug } = await params
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { ...PUBLIC_HEADERS, 'Cache-Control': 'no-store', ...extra } })

  const p = SLUG_PATTERN.test(slug) ? getBySlug(slug) : undefined
  if (!p || isExpired(p) || !p.pinHash) return json(404, { error: 'not_found' })

  const ip = clientIp(req.headers)
  const before = attemptState(slug, ip)
  if (!before.allowed) return json(429, { error: 'locked', retryAfter: before.retryAfterSec }, { 'Retry-After': String(before.retryAfterSec) })

  const body = (await req.json().catch(() => null)) as { pin?: unknown } | null
  const pin = typeof body?.pin === 'string' ? body.pin : ''
  if (!(await verifyPin(p, pin))) {
    recordFailedAttempt(slug, ip)
    const after = attemptState(slug, ip)
    if (!after.allowed) return json(429, { error: 'locked', retryAfter: after.retryAfterSec }, { 'Retry-After': String(after.retryAfterSec) })
    return json(401, { error: 'wrong_pin', remaining: after.remaining })
  }

  clearAttempts(slug, ip)
  const secure = (process.env.BASE_URL ?? '').startsWith('https://')
  const cookie = [
    `${accessCookieName(slug)}=${signAccess(p)}`,
    `Path=/p/${slug}`,
    `Max-Age=${ACCESS_TTL_MS / 1000}`,
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
  return json(200, { ok: true }, { 'Set-Cookie': cookie })
}
