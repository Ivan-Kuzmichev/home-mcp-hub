import dns from 'node:dns'
import { isIP } from 'node:net'
import { Agent } from 'undici'

/**
 * Scripts may reach any external address, never the local network (NAS, docker network,
 * router, cloud metadata). The check runs inside the connection's DNS lookup, so a hostname
 * that resolves to a private address — or starts to, between check and connect — is refused.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number) as [number, number]
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    )
  }
  const v6 = ip.toLowerCase()
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')
}

export class NetworkPolicyError extends Error {}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void

function guardedLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '')
    const list = addresses as dns.LookupAddress[]
    const bad = list.find((a) => isPrivateAddress(a.address))
    if (bad) return cb(Object.assign(new NetworkPolicyError(`${hostname} → ${bad.address}: локальная сеть скриптам недоступна`), { code: 'EPOLICY' }), '')
    if (options.all) return cb(null, list)
    cb(null, list[0]!.address, list[0]!.family)
  })
}

const globalForNet = globalThis as unknown as { __hubScriptAgent?: Agent }
export const scriptAgent = (globalForNet.__hubScriptAgent ??= new Agent({ connect: { lookup: guardedLookup as never }, connectTimeout: 10_000 }))

/** URL checks that do not need DNS: scheme and literal private IPs. */
export function assertPublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new NetworkPolicyError(`Неверный адрес: ${raw.slice(0, 80)}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new NetworkPolicyError('Только http и https')
  if (url.username || url.password) throw new NetworkPolicyError('Логин и пароль в адресе не поддерживаются — используй заголовки и секреты')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && isPrivateAddress(host)) throw new NetworkPolicyError(`${host}: локальная сеть скриптам недоступна`)
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) {
    throw new NetworkPolicyError(`${host}: локальные имена скриптам недоступны`)
  }
  return url
}
