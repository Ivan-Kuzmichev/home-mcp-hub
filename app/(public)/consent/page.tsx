import type { Metadata } from 'next'
import { eq } from 'drizzle-orm'
import { Check } from 'lucide-react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { LogoMark } from '@/components/logo'
import { ConsentActions, NotMeLink } from '@/components/oauth/consent-actions'
import { PrefixProvider } from '@/components/prefix-provider'
import { Card } from '@/components/ui/card'
import { getAuth } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { oauthClient } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { prefixedIcons } from '@/lib/icons'
import { shortId } from '@/lib/format'
import { getPrefix, href } from '@/lib/prefix'

export const dynamic = 'force-dynamic'

export function generateMetadata(): Metadata {
  return { icons: prefixedIcons() }
}

const CAPABILITIES = [
  'Поиск торрентов через Jackett',
  'Управление закачками в qBittorrent и TorrServe',
  'Публикация и удаление прототипов',
]

type SearchParams = Promise<Record<string, string | string[] | undefined>>

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

export default async function ConsentPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : [])),
  ).toString()

  const session = await getAuth().api.getSession({ headers: await headers() })
  // The signed query is still valid on the login page; come back here after 2FA.
  if (!session?.user.twoFactorEnabled) redirect(`${href('/login')}${query ? `?${query}` : ''}`)

  const clientId = one(params.client_id)
  const redirectUri = one(params.redirect_uri)
  const client = clientId
    ? getDb().select({ name: oauthClient.name, uri: oauthClient.uri }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).get()
    : undefined

  const prefix = getPrefix()
  const host = new URL(env().BASE_URL).host
  const clientLabel = client?.name ? `${client.name}${redirectUri ? ` · ${new URL(redirectUri).host}` : ''}` : 'Неизвестный клиент'

  return (
    <PrefixProvider prefix={prefix}>
      <div className="flex min-h-dvh flex-col gap-8 px-5 py-6 sm:px-12 sm:py-10">
        <header className="flex items-center gap-2.5">
          <LogoMark />
          <div className="font-heading text-base font-bold">Home Hub</div>
          <div className="hidden truncate font-mono text-xs text-subtle sm:block">
            {host}/{prefix}/consent
          </div>
        </header>

        <main className="flex flex-1 items-center justify-center">
          <Card className="flex w-full max-w-[460px] flex-col gap-5 p-6 sm:p-8">
            {!client ? (
              <div className="flex flex-col gap-1.5">
                <h1 className="text-2xl">Запрос устарел</h1>
                <div className="text-muted-foreground">Клиент не найден. Начни подключение в Claude заново.</div>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <h1 className="text-2xl">{client.name ?? 'Клиент'} запрашивает доступ к Home Hub</h1>
                  <div className="text-muted-foreground">
                    Приложение сможет вызывать инструменты хаба от твоего имени, пока ты не отзовёшь доступ в админке.
                  </div>
                </div>

                <ul className="flex flex-col gap-2.5">
                  {CAPABILITIES.map((c) => (
                    <li key={c} className="flex items-center gap-2.5">
                      <span className="flex size-5 items-center justify-center rounded-full bg-ok/14 text-ok">
                        <Check size={12} strokeWidth={3} />
                      </span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>

                <dl className="flex flex-col gap-2 rounded-md border border-border bg-background p-3.5 text-[13px]">
                  <Row label="Клиент" value={clientLabel} />
                  <Row label="client_id" value={shortId(clientId ?? '')} mono />
                  {redirectUri && <Row label="Redirect URI" value={redirectUri} mono />}
                </dl>

                <ConsentActions />

                <div className="text-center text-xs text-subtle">
                  Ты вошёл как {session.user.email} · <NotMeLink />
                </div>
              </>
            )}
          </Card>
        </main>

        <footer className="flex flex-wrap justify-between gap-2 text-xs text-faint">
          <span>Токен живёт 1 час, обновляется автоматически 30 дней</span>
          <span className="font-mono">OAuth 2.1 · PKCE</span>
        </footer>
      </div>
    </PrefixProvider>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-subtle">{label}</dt>
      <dd className={mono ? 'truncate font-mono text-xs leading-5 text-muted-foreground' : 'truncate text-muted-foreground'}>{value}</dd>
    </div>
  )
}
