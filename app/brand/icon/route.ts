import { LOGO_SVG } from '@/lib/brand'

/** Favicon, served under the secret prefix like the rest of the hub. */
export function GET(): Response {
  return new Response(LOGO_SVG, {
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' },
  })
}
