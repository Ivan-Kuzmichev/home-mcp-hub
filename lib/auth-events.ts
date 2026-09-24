import { logAuthEvent } from './journal'
import { isDcrAllowed, setDcrAllowed } from './settings'

type Input = { method: string; path: string; body: ArrayBuffer | undefined; response: Response; ip: string }

function json(buf: ArrayBuffer | undefined): Record<string, unknown> {
  if (!buf?.byteLength) return {}
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(buf))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function failure(status: number): string {
  if (status === 429) return 'лимит попыток'
  if (status === 401) return 'неверные данные'
  if (status === 403) return 'запрещено'
  return `ошибка ${status}`
}

/** Journal entries for sign-in steps and OAuth consent. Never records passwords or codes. */
export async function recordAuthEvent({ method, path, body, response, ip }: Input): Promise<void> {
  if (method !== 'POST') return
  const req = json(body)
  const res = response.ok ? ((await response.clone().json().catch(() => ({}))) as Record<string, unknown>) : {}
  const email = typeof req.email === 'string' ? req.email.toLowerCase() : null

  if (path === '/sign-in/email') {
    const detail = [email, response.ok ? (res.twoFactorRedirect ? 'пароль верный, ждём код' : 'пароль, 2FA не настроена') : null, ip].filter(Boolean).join(' · ')
    logAuthEvent({ event: 'auth.password', ok: response.ok, detail, error: response.ok ? undefined : failure(response.status), ip })
    return
  }

  if (path === '/two-factor/verify-totp' || path === '/two-factor/verify-backup-code') {
    const user = res.user as { email?: string } | undefined
    const method2 = path.endsWith('backup-code') ? 'резервный код' : 'TOTP'
    const detail = [user?.email, method2, ip].filter(Boolean).join(' · ')
    logAuthEvent({ event: 'auth.second_factor', ok: response.ok, detail, error: response.ok ? undefined : failure(response.status), ip })
    return
  }

  if (path === '/oauth2/consent') {
    const accepted = req.accept === true
    // Claude is connected: close client registration so nobody else can register meanwhile.
    const closeDcr = response.ok && accepted && isDcrAllowed()
    if (closeDcr) setDcrAllowed(false)
    const detail = [accepted ? 'разрешено' : 'отказано', closeDcr ? 'регистрация клиентов выключена' : null, ip].filter(Boolean).join(' · ')
    logAuthEvent({ event: 'auth.consent', ok: response.ok, detail, error: response.ok ? undefined : failure(response.status), ip })
  }
}
