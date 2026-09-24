import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { LoginForm } from '@/components/auth/login-form'
import { LogoMark } from '@/components/logo'
import { PrefixProvider } from '@/components/prefix-provider'
import { getAuth } from '@/lib/auth'
import { env } from '@/lib/env'
import { getPrefix, href } from '@/lib/prefix'
import { HUB_VERSION } from '@/lib/version'

export const dynamic = 'force-dynamic'

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Claude's authorization request sends the user here with a signed query (sig=…).
  const oauth = typeof (await searchParams).sig === 'string'
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (session?.user.twoFactorEnabled && !oauth) redirect(href('/admin'))

  const prefix = getPrefix()
  const host = new URL(env().BASE_URL).host
  // A wrong BASE_URL makes better-auth reject every sign-in as a foreign origin: say so upfront.
  const h = await headers()
  const requestHost = h.get('x-forwarded-host') ?? h.get('host')
  const hostMismatch = !!requestHost && requestHost !== host

  return (
    <PrefixProvider prefix={prefix}>
      <div className="flex min-h-dvh flex-col gap-8 px-5 py-6 sm:px-12 sm:py-10">
        <header className="flex items-center gap-2.5">
          <LogoMark />
          <div className="font-heading text-base font-bold">Home Hub</div>
          <div className="hidden truncate font-mono text-xs text-subtle sm:block">
            {host}/{prefix}/login
          </div>
        </header>
        {hostMismatch && (
          <div role="alert" className="mx-auto w-full max-w-[520px] rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-[13px] text-warn">
            Страница открыта как <span className="font-mono">{requestHost}</span>, а в .env хаба <span className="font-mono">BASE_URL={env().BASE_URL}</span>.
            Вход не сработает: поправь BASE_URL и перезапусти контейнер.
          </div>
        )}
        <main className="flex flex-1 items-center justify-center">
          <LoginForm initialStep={session && !session.user.twoFactorEnabled ? 'setup' : 'password'} oauth={oauth} />
        </main>
        <footer className="flex justify-between text-xs text-faint">
          <span>Home MCP Hub · self-hosted</span>
          <span className="font-mono">v{HUB_VERSION}</span>
        </footer>
      </div>
    </PrefixProvider>
  )
}
