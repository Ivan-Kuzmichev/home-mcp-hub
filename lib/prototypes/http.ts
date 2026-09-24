// Headers for everything under /p/*. The prototype HTML runs in an opaque origin
// (sandbox without allow-same-origin): no access to admin cookies or storage.
export const PROTOTYPE_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-popups'

export const PUBLIC_HEADERS: Record<string, string> = {
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

export const SLUG_PATTERN = /^[a-z0-9]{6,16}$/

export function simplePage(status: number, title: string, text: string): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0E1014;color:#E9EBF0;font:15px/1.5 system-ui,sans-serif;padding:24px;box-sizing:border-box}
main{max-width:360px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#A2A9B6;margin:0}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`
  return new Response(html, {
    status,
    headers: { ...PUBLIC_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" },
  })
}
