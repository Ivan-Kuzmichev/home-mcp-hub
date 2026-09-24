'use client'

import { useState } from 'react'
import { useHref } from '@/components/prefix-provider'
import { Button } from '@/components/ui/button'
import { authErrorMessage, oauthRedirectUrl, useAuthClient } from '@/lib/auth-client'

export function ConsentActions() {
  const auth = useAuthClient({ oauth: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function decide(accept: boolean) {
    setBusy(true)
    setError(null)
    // oauthProviderClient adds the signed oauth_query from this page's URL.
    const { data, error } = await auth.$fetch('/oauth2/consent', { method: 'POST', body: { accept } })
    const url = oauthRedirectUrl(data)
    if (error || !url) {
      setBusy(false)
      return setError(authErrorMessage(error, 'Запрос устарел. Начни подключение в Claude заново.'))
    }
    window.location.assign(url)
  }

  return (
    <>
      {error && (
        <div role="alert" className="text-[13px] text-err">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2.5">
        <Button disabled={busy} onClick={() => decide(false)}>
          Отказать
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => decide(true)}>
          Разрешить
        </Button>
      </div>
    </>
  )
}

export function NotMeLink() {
  const auth = useAuthClient()
  const href = useHref()
  return (
    <button
      type="button"
      className="cursor-pointer text-primary hover:text-primary-hover"
      onClick={async () => {
        await auth.signOut()
        window.location.assign(href('/login'))
      }}
    >
      Это не я
    </button>
  )
}
