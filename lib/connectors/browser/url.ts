import dns from 'node:dns'
import { isIP } from 'node:net'
import { isPrivateAddress } from '../../scripts/net'
import { ToolError } from '../types'
import { t } from '../../i18n'

/**
 * URL checks before camofox opens a page. The network (dockfw) already keeps camofox off the LAN;
 * this is the second line: scheme, local names, every resolved address public, domain lists.
 */

export type DomainLists = { allow: string[]; deny: string[] }

/** «example.com» matches the domain and its subdomains, «*.example.com» only subdomains. */
export function parseDomains(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/\.$/, ''))
    .filter((d) => d && !d.startsWith('#'))
}

export function domainMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1))
  return h === pattern || h.endsWith(`.${pattern}`)
}

export type Resolve = (host: string) => Promise<string[]>

const systemResolve: Resolve = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address)

const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|arpa)$/

/** Throws ToolError naming the failed check; returns the parsed URL. */
export async function checkUrl(raw: string, lists: DomainLists, resolve: Resolve = systemResolve): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ToolError(t`Address refused: not a URL (${raw.slice(0, 80)})`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError(t`Address refused: only http and https, not ${url.protocol}`)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new ToolError(t`Address refused: ${host} is a private address`)
    // An allowlist of names does not let bare addresses through.
    if (lists.allow.length) throw new ToolError(t`Address refused: ${host} is not in the allowlist`)
  } else {
    if (LOCAL_NAME.test(host) || !host.includes('.')) throw new ToolError(t`Address refused: ${host} is a local name`)
    const deny = lists.deny.find((d) => domainMatches(host, d))
    if (deny) throw new ToolError(t`Address refused: ${host} is in the denylist (${deny})`)
    if (lists.allow.length && !lists.allow.some((d) => domainMatches(host, d))) throw new ToolError(t`Address refused: ${host} is not in the allowlist`)
    let addresses: string[]
    try {
      addresses = await resolve(host)
    } catch {
      throw new ToolError(t`Address refused: ${host} does not resolve`)
    }
    if (addresses.length === 0) throw new ToolError(t`Address refused: ${host} does not resolve`)
    const bad = addresses.find(isPrivateAddress)
    if (bad) throw new ToolError(t`Address refused: ${host} → ${bad} is a private address`)
  }
  return url
}
