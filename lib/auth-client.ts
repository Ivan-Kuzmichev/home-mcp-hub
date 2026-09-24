'use client'

import { useMemo } from 'react'
import { createAuthClient } from 'better-auth/react'
import { twoFactorClient } from 'better-auth/client/plugins'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { usePrefix } from '@/components/prefix-provider'

function create(prefix: string, oauth: boolean) {
  // The client is only called from event handlers; during SSR the origin is never used.
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  return createAuthClient({
    baseURL: `${origin}/${prefix}/api/auth`,
    // oauthProviderClient attaches the signed OAuth query from the page URL to every POST,
    // so it is only enabled on the login and consent pages of the OAuth flow.
    plugins: oauth ? [twoFactorClient(), oauthProviderClient()] : [twoFactorClient()],
  })
}

export type HubAuthClient = ReturnType<typeof create>

export function useAuthClient({ oauth = false }: { oauth?: boolean } = {}): HubAuthClient {
  const prefix = usePrefix()
  return useMemo(() => create(prefix, oauth), [prefix, oauth])
}

/** During an OAuth flow better-auth answers with { redirect: true, url } once the session is ready. */
export function oauthRedirectUrl(data: unknown): string | null {
  if (data && typeof data === 'object' && 'redirect' in data && 'url' in data) {
    const { redirect, url } = data as { redirect: unknown; url: unknown }
    if (redirect === true && typeof url === 'string') return url
  }
  return null
}

type AuthError = { status?: number; code?: string; message?: string } | null | undefined

/** Map better-auth errors to short Russian messages. */
export function authErrorMessage(error: AuthError, fallback = 'Не получилось. Попробуй ещё раз.'): string {
  if (!error) return fallback
  if (error.status === 429) return 'Слишком много попыток. Подожди 15 минут.'
  switch (error.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
      return 'Неверный email или пароль.'
    case 'INVALID_PASSWORD':
      return 'Неверный пароль.'
    case 'INVALID_CODE':
    case 'INVALID_BACKUP_CODE':
      return 'Неверный код.'
    case 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE':
    case 'INVALID_TWO_FACTOR_COOKIE':
      return 'Сессия входа истекла. Введи пароль заново.'
    case 'ACCOUNT_TEMPORARILY_LOCKED':
      return 'Слишком много неверных кодов. Вход заблокирован на 15 минут.'
    default:
      return fallback
  }
}
