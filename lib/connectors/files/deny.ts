/**
 * Files the model must never read, find, copy or share, whatever folder they are in:
 * keys, passwords, VPN configs. A mask matches a file or folder name anywhere in the path,
 * so «.ssh» closes the whole folder. Case-insensitive; * and ? like in a shell.
 */
export const DEFAULT_DENY = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.kdbx',
  'id_rsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.ssh',
  '.netrc',
  '.git-credentials',
  'wireguard*.conf',
  '*secret*',
].join('\n')

export type DenyMatcher = (name: string) => boolean

export function parseDeny(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[\n,]+/)
    .map((m) => m.trim())
    .filter((m) => m && !m.startsWith('#'))
}

export function denyMatcher(masks: string[]): DenyMatcher {
  if (masks.length === 0) return () => false
  const res = masks.map((m) => new RegExp(`^${m.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'))
  return (name) => res.some((re) => re.test(name))
}

/** The first closed name among the path segments, or null. */
export function deniedSegment(segments: string[], deny: DenyMatcher | undefined): string | null {
  return deny ? (segments.find((s) => deny(s)) ?? null) : null
}
