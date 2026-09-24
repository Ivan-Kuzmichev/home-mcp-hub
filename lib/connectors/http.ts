import { ToolError } from './types'

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
  if (code === 'ECONNREFUSED') return 'соединение отклонено'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'адрес не найден'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'хост недоступен'
  if (code === 'ECONNRESET') return 'соединение сброшено'
  return code ?? 'сетевая ошибка'
}

/**
 * fetch with a timeout and short Russian errors. The service name goes into the
 * message: «qBittorrent не ответил за 30 с».
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
    if (timeout.aborted) throw new ToolError(`${service} не ответил за ${Math.round(timeoutMs / 1000)} с`)
    if (signal?.aborted) throw error
    throw new ToolError(`${service} недоступен: ${describeNetworkError(error)}`)
  }
}

export async function expectOk(service: string, res: Response, what: string): Promise<Response> {
  if (res.ok) return res
  if (res.status === 401 || res.status === 403) throw new ToolError(`${service}: нет доступа (${res.status}) — проверь способ входа`)
  const body = scrub((await res.text().catch(() => '')).slice(0, 120))
  throw new ToolError(`${service}: ${what} — ошибка ${res.status}${body ? `: ${body}` : ''}`)
}
