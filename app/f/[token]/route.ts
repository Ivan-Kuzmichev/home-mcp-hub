import { headers } from 'next/headers'
import { getAuth } from '@/lib/auth'
import { activeConfig } from '@/lib/connectors/active'
import { PlClient } from '@/lib/connectors/paperless/client'
import { claimLink, getLink } from '@/lib/connectors/paperless/logic'
import { logger } from '@/lib/logger'
import { PUBLIC_HEADERS, simplePage } from '@/lib/prototypes/http'

export const dynamic = 'force-dynamic'

const TOKEN = /^[A-Za-z0-9_-]{32}$/
// Shown inline in the browser; everything else downloads.
const INLINE = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/

/**
 * Document download: /f/{token}, outside the secret prefix so a shared link does not reveal it.
 * Personal links need the admin session; shareable ones open once within 15 minutes.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params
  const link = TOKEN.test(token) ? getLink(token) : undefined
  if (!link) return simplePage(404, 'Ссылка не найдена', 'Возможно, в ней опечатка.')
  if (link.expiresAt.getTime() < Date.now()) return simplePage(410, 'Ссылка устарела', 'Попроси ассистента сделать новую.')

  if (link.shareable) {
    if (!claimLink(token)) return simplePage(410, 'Ссылка уже использована', 'Одноразовая ссылка открывается только один раз.')
  } else {
    const session = await getAuth().api.getSession({ headers: await headers() })
    if (!session?.user.twoFactorEnabled) {
      return simplePage(403, 'Личная ссылка', 'Она открывается только в браузере, где выполнен вход в админку хаба.')
    }
  }

  const config = activeConfig(link.connectorId) as { baseUrl: string; apiToken?: string } | null
  if (!config) return simplePage(503, 'Paperless выключен', 'Коннектор Paperless отключён в админке хаба.')

  try {
    const upstream = await new PlClient(config).download(link.documentId, link.original)
    const type = upstream.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream'
    const disposition = upstream.headers.get('content-disposition') ?? `attachment; filename="document-${link.documentId}"`
    logger.info({ document: link.documentId, shareable: link.shareable }, 'document downloaded')
    return new Response(upstream.body, {
      headers: {
        ...PUBLIC_HEADERS,
        'Content-Type': type,
        'Content-Disposition': INLINE.test(type) ? disposition.replace(/^attachment/, 'inline') : disposition,
        ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length')! } : {}),
        // An HTML or SVG original must not run in the hub's origin.
        'Content-Security-Policy': 'sandbox',
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'document download failed')
    return simplePage(502, 'Не получилось скачать', 'Paperless не отдал файл. Попробуй позже.')
  }
}
