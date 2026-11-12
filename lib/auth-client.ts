'use client'

import { useMemo } from 'react'
import { createAuthClient } from 'better-auth/react'
import { twoFactorClient } from 'better-auth/client/plugins'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { usePrefix } from '@/components/prefix-provider'
import { t } from '@/components/i18n-client'

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
export function authErrorMessage(error: AuthError, fallback = t`Failed. Try again.`): string {
  if (!error) return fallback
  if (error.status === 429) return t`Too many attempts. Wait 15 minutes.`
  switch (error.code) {
    case 'INVALID_ORIGIN':
    case 'MISSING_OR_NULL_ORIGIN':
    case 'CROSS_SITE_NAVIGATION_LOGIN_BLOCKED':
      return t`Sign-in from this address was refused: it does not match BASE_URL in the hub .env.`
    case 'INVALID_EMAIL_OR_PASSWORD':
      return t`Wrong email or password.`
    case 'INVALID_PASSWORD':
      return t`Wrong password.`
    case 'INVALID_CODE':
    case 'INVALID_BACKUP_CODE':
      return t`Wrong code.`
    case 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE':
    case 'INVALID_TWO_FACTOR_COOKIE':
      return t`The sign-in session expired. Enter the password again.`
    case 'ACCOUNT_TEMPORARILY_LOCKED':
      return t`Too many wrong codes. Sign-in is blocked for 15 minutes.`
    default:
      return fallback
  }
}
