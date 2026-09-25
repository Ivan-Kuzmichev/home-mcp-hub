import { getSetting, setSetting } from './settings'

/**
 * Which AI clients may register over DCR, identified by their OAuth redirect URIs.
 * Registration also needs the allow_dcr switch, and tokens still need the admin's
 * login, 2FA and consent.
 */
export type ClientKind = 'claude' | 'chatgpt' | 'loopback'

export type ClientPreset = {
  id: ClientKind
  name: string
  hint: string
  examples: string[]
  matches: (uri: URL) => boolean
}

const exact = (list: string[]) => (u: URL) => list.includes(u.toString())

export const CLIENT_PRESETS: ClientPreset[] = [
  {
    id: 'claude',
    name: 'Claude',
    hint: 'claude.ai, приложения Claude на телефоне и компьютере',
    examples: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
    matches: exact(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']),
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    hint: 'коннекторы ChatGPT (developer mode)',
    examples: ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/{id}'],
    // Stable URI when the server returns `iss` (the hub does); the per-connector one otherwise.
    matches: (u) =>
      u.protocol === 'https:' &&
      u.host === 'chatgpt.com' &&
      !u.search &&
      (u.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname)),
  },
  {
    id: 'loopback',
    name: 'Claude Code и локальные клиенты',
    hint: 'redirect на localhost (RFC 8252): код уходит только на машину, где запущен клиент',
    examples: ['http://localhost:{port}/callback', 'http://127.0.0.1:{port}/callback'],
    matches: (u) => u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'),
  },
]

const DEFAULT_KINDS: ClientKind[] = ['claude', 'chatgpt']
const SETTING = 'allowed_clients'

export function getAllowedClients(): ClientKind[] {
  const raw = getSetting(SETTING)
  if (!raw) return DEFAULT_KINDS
  try {
    const list: unknown = JSON.parse(raw)
    return Array.isArray(list) ? CLIENT_PRESETS.map((p) => p.id).filter((id) => list.includes(id)) : DEFAULT_KINDS
  } catch {
    return DEFAULT_KINDS
  }
}

export function setAllowedClients(kinds: ClientKind[]): void {
  setSetting(SETTING, JSON.stringify(kinds))
}

/** The preset a redirect URI belongs to, if it is allowed. */
export function allowedRedirect(uri: string, kinds: ClientKind[] = getAllowedClients()): ClientPreset | null {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  if (url.username || url.password || url.hash) return null
  return CLIENT_PRESETS.find((p) => kinds.includes(p.id) && p.matches(url)) ?? null
}
