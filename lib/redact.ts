// Shared masking of tokens in headers, URLs and bodies. Pure module, no hub imports.

const MASK = '***'
const JWT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g

const EXACT_NAMES = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'password', 'pass', 'passwd', 'secret', 'client_secret',
  'api_key', 'apikey', 'session', 'sid', 'code', 'jwt', 'otp', 'pin', 'authorization',
])
const SUBSTRINGS = ['token', 'secret', 'session', 'auth', 'password', 'passwd']

export function isSensitiveName(name: string): boolean {
  // x-api-key -> api_key
  const n = name.trim().toLowerCase().replace(/-/g, '_').replace(/^x_/, '')
  if (!n) return false
  return EXACT_NAMES.has(n) || SUBSTRINGS.some((s) => n.includes(s))
}

export function maskValue(v: string): string {
  return `${MASK} (${v.length} симв.)`
}

function maskJwts(text: string): string {
  return text.replace(JWT_RE, MASK)
}

const URL_HEADERS = new Set(['location', 'referer', 'origin', 'content-location'])

function maskCookiePairs(value: string, firstOnly: boolean): string {
  return value
    .split(';')
    .map((part, i) => {
      if (firstOnly && i > 0) return part
      const eq = part.indexOf('=')
      if (eq < 0) return part
      return `${part.slice(0, eq + 1)}${MASK}`
    })
    .join(';')
}

export function maskHeaders(h: [string, string][]): [string, string][] {
  return h.map(([name, value]): [string, string] => {
    const n = name.toLowerCase()
    if (URL_HEADERS.has(n)) return [name, maskUrl(value)]
    if (n === 'cookie') return [name, maskCookiePairs(value, false)]
    if (n === 'set-cookie') return [name, maskCookiePairs(value, true)]
    if (n === 'authorization' || n === 'proxy-authorization') return [name, maskValue(value)]
    if (isSensitiveName(n)) return [name, MASK]
    return [name, maskJwts(value)]
  })
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

function maskPairs(query: string): string {
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return pair
      return isSensitiveName(safeDecode(pair.slice(0, eq))) ? `${pair.slice(0, eq + 1)}${MASK}` : pair
    })
    .join('&')
}

export function maskUrl(url: string): string {
  const hash = url.indexOf('#')
  const base = hash < 0 ? url : url.slice(0, hash)
  const rawFrag = hash < 0 ? '' : url.slice(hash + 1)
  const frag = hash < 0 ? '' : `#${rawFrag.includes('=') ? maskPairs(rawFrag) : rawFrag}`
  const q = base.indexOf('?')
  const path = (q < 0 ? base : base.slice(0, q)).replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*):[^/?#@]*@/i, '$1:***@')
  const query = q < 0 ? '' : `?${maskPairs(base.slice(q + 1))}`
  return maskJwts(path + query) + maskJwts(frag)
}

function maskAll(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskAll)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskAll(v)]))
  }
  return MASK
}

function maskJson(value: unknown): unknown {
  if (typeof value === 'string') return maskJwts(value)
  if (Array.isArray(value)) return value.map(maskJson)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveName(k) ? maskAll(v) : maskJson(v)
    }
    return out
  }
  return value
}

export function maskBody(text: string, contentType: string | undefined): string {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('json')) {
    try {
      return JSON.stringify(maskJson(JSON.parse(text)))
    } catch {
      return maskJwts(text)
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) return maskJwts(maskPairs(text))
  return maskJwts(text)
}
