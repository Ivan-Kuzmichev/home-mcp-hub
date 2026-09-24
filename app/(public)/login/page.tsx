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

export default async function LoginPage() {
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (session?.user.twoFactorEnabled) redirect(href('/admin'))

  const prefix = getPrefix()
  const host = new URL(env().BASE_URL).host

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
        <main className="flex flex-1 items-center justify-center">
          <LoginForm initialStep={session ? 'setup' : 'password'} />
        </main>
        <footer className="flex justify-between text-xs text-faint">
          <span>Home MCP Hub · self-hosted</span>
          <span className="font-mono">v{HUB_VERSION}</span>
        </footer>
      </div>
    </PrefixProvider>
  )
}
