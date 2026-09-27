import dns from 'node:dns'
import { isIP } from 'node:net'
import { Agent } from 'undici'

/**
 * Where scripts may connect: external addresses and/or the local network (NAS, docker network,
 * router), both switched in the connector settings. The check runs inside the connection's DNS
 * lookup, so a hostname that resolves to a forbidden address — or starts to, between check and
 * connect — is refused.
 */
export type NetPolicy = { local: boolean; external: boolean }

export const DEFAULT_NET_POLICY: NetPolicy = { local: false, external: true }

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

/** Why this address is off limits under the policy, or null when it is allowed. */
function refusal(ip: string, policy: NetPolicy): string | null {
  if (isPrivateAddress(ip)) return policy.local ? null : 'локальная сеть скриптам недоступна'
  return policy.external ? null : 'внешние адреса скриптам недоступны'
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void

function guardedLookup(policy: NetPolicy) {
  return (hostname: string, options: dns.LookupOptions, cb: LookupCb): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, '')
      const list = addresses as dns.LookupAddress[]
      for (const a of list) {
        const why = refusal(a.address, policy)
        if (why) return cb(Object.assign(new NetworkPolicyError(`${hostname} → ${a.address}: ${why}`), { code: 'EPOLICY' }), '')
      }
      if (options.all) return cb(null, list)
      cb(null, list[0]!.address, list[0]!.family)
    })
  }
}

const globalForNet = globalThis as unknown as { __hubScriptAgents?: Map<string, Agent> }
const agents = (globalForNet.__hubScriptAgents ??= new Map())

/** undici dispatcher that enforces the policy on every connection. */
export function scriptAgent(policy: NetPolicy = DEFAULT_NET_POLICY): Agent {
  const key = `${policy.local}:${policy.external}`
  let agent = agents.get(key)
  if (!agent) {
    agent = new Agent({ connect: { lookup: guardedLookup(policy) as never }, connectTimeout: 10_000 })
    agents.set(key, agent)
  }
  return agent
}

/** URL checks that do not need DNS: scheme, literal IPs and local names. */
export function assertAllowedUrl(raw: string, policy: NetPolicy = DEFAULT_NET_POLICY): URL {
  if (!policy.local && !policy.external) throw new NetworkPolicyError('Сеть скриптам выключена в настройках коннектора')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new NetworkPolicyError(`Неверный адрес: ${raw.slice(0, 80)}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new NetworkPolicyError('Только http и https')
  if (url.username || url.password) throw new NetworkPolicyError('Логин и пароль в адресе не поддерживаются — используй заголовки и секреты')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    const why = refusal(host, policy)
    if (why) throw new NetworkPolicyError(`${host}: ${why}`)
  } else if (!policy.local && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.'))) {
    throw new NetworkPolicyError(`${host}: локальные имена скриптам недоступны`)
  }
  return url
}

/** The default policy: external addresses only. */
export const assertPublicUrl = (raw: string): URL => assertAllowedUrl(raw, DEFAULT_NET_POLICY)
