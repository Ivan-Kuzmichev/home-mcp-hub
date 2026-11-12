import { ToolError } from './types'
import { t } from '../i18n'

export const SERVICE_TIMEOUT_MS = 30_000

/** Remove credentials from anything that might end up in a message or log. */
export function scrub(text: string): string {
  return text
    .replace(/([?&](?:apikey|api_key|jackett_apikey|passkey|token)=)[^&\s"']+/gi, '$1***')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***@')
}

function describeNetworkError(error: unknown): string {
  const cause = (error as { cause?: { code?: string } }).cause
  const code = cause?.code
  if (code === 'ECONNREFUSED') return t`connection refused`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return t`address not found`
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return t`host unreachable`
  if (code === 'ECONNRESET') return t`connection reset`
  return code ?? t`network error`
}

/**
 * fetch with a timeout and short Russian errors. The service name goes into the
 * message: «qBittorrent did not respond in 30 s».
 */
export async function serviceFetch(
  service: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = SERVICE_TIMEOUT_MS, signal, ...rest } = init
  const timeout = AbortSignal.timeout(timeoutMs)
  try {
    return await fetch(url, { ...rest, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  } catch (error) {
    if (timeout.aborted) throw new ToolError(t`${service} did not respond in ${Math.round(timeoutMs / 1000)} s`)
    if (signal?.aborted) throw error
    throw new ToolError(t`${service} is unreachable: ${describeNetworkError(error)}`)
  }
}

export async function expectOk(service: string, res: Response, what: string): Promise<Response> {
  if (res.ok) return res
  if (res.status === 401 || res.status === 403) throw new ToolError(t`${service}: access denied (${res.status}) — check the sign-in method`)
  const body = scrub((await res.text().catch(() => '')).slice(0, 120))
  throw new ToolError(t`${service}: ${what} — error ${res.status}${body ? `: ${body}` : ''}`)
}
