import type { Metadata } from 'next'
import { MobileTabs, SidebarNav } from '@/components/admin/nav'
import { SignOutButton } from '@/components/admin/sign-out-button'
import { LogoMark } from '@/components/logo'
import { PrefixProvider } from '@/components/prefix-provider'
import { connectorStates } from '@/lib/connectors/active'
import { env } from '@/lib/env'
import { prefixedIcons } from '@/lib/icons'
import { getPrefix } from '@/lib/prefix'
import { requireAdmin } from '@/lib/session'

export const dynamic = 'force-dynamic'

export function generateMetadata(): Metadata {
  return { icons: prefixedIcons() }
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin()
  const prefix = getPrefix()
  const host = new URL(env().BASE_URL).host
  const name = session.user.name || session.user.email
  // Sections of switched-off connectors disappear from the navigation.
  const states = connectorStates()
  const isOn = (id: string) => states.find((c) => c.connector.id === id)?.status === 'active'
  const hidden = [!isOn('prototypes') && '/admin/prototypes', !isOn('scripts') && '/admin/scripts'].filter((p): p is string => !!p)

  return (
    <PrefixProvider prefix={prefix}>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col gap-6 border-r border-border bg-panel px-3.5 py-5 md:flex">
          <div className="flex items-center gap-2.5 px-1.5">
            <LogoMark />
            <div className="flex min-w-0 flex-col">
              <div className="font-heading text-[15px] leading-[18px] font-bold">Home Hub</div>
              <div className="truncate font-mono text-[11px] text-subtle">
                {host}/{prefix}
              </div>
            </div>
          </div>
          <SidebarNav hidden={hidden} />
          <div className="flex-1" />
          <div className="flex items-center gap-2.5 border-t border-border px-2 pt-3">
            <div className="flex size-[30px] items-center justify-center rounded-full border border-border bg-secondary text-[13px] font-semibold uppercase">
              {name.slice(0, 1)}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium">{name}</span>
              <span className="text-[11px] text-subtle">админ · 2FA включена</span>
            </div>
            <SignOutButton />
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col gap-3.5 p-4 pb-28 md:gap-[22px] md:px-8 md:py-7">{children}</main>
        <MobileTabs hidden={hidden} />
      </div>
    </PrefixProvider>
  )
}
