import { isIPv4 } from 'node:net'

/** Client IP: the first X-Forwarded-For hop when TRUST_PROXY is on (Traefik/Pangolin), else x-real-ip. */
export function clientIp(headers: Headers): string {
  if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (forwarded) return forwarded
  }
  return headers.get('x-real-ip') ?? 'direct'
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0)
}

export function isValidCidr(cidr: string): boolean {
  const [ip, bits] = cidr.split('/')
  if (!ip || !isIPv4(ip)) return false
  if (bits === undefined) return true
  const n = Number(bits)
  return Number.isInteger(n) && n >= 0 && n <= 32
}

/** IPv4 CIDR match («160.79.104.0/21»); a bare address matches itself. IPv6 compares as exact strings. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const mapped = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  const [net, bitsText] = cidr.split('/')
  if (!net) return false
  if (!isIPv4(mapped) || !isIPv4(net)) return mapped === net
  const bits = bitsText === undefined ? 32 : Number(bitsText)
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(mapped) & mask) === (ipv4ToInt(net) & mask)
}
