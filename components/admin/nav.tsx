'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { MOBILE_TABS, MORE_PATHS, NAV_ITEMS } from '@/components/admin/nav-items'
import { usePrefix, useHref } from '@/components/prefix-provider'
import { cn } from '@/lib/utils'

/** Current in-app path without the secret prefix. */
function useAppPath(): string {
  const pathname = usePathname()
  const prefix = usePrefix()
  if (pathname === `/${prefix}`) return '/'
  return pathname.startsWith(`/${prefix}/`) ? pathname.slice(prefix.length + 1) : pathname
}

function isActive(current: string, path: string): boolean {
  if (path === '/admin') return current === '/admin'
  if (path === '/admin/more') return MORE_PATHS.some((p) => current === p || current.startsWith(`${p}/`))
  return current === path || current.startsWith(`${path}/`)
}

export function SidebarNav() {
  const current = useAppPath()
  const href = useHref()
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
        <Link
          key={path}
          href={href(path)}
          className={cn(
            'flex items-center gap-2.5 rounded-sm px-3 py-[9px] text-sm font-medium text-muted-foreground no-underline hover:bg-secondary hover:text-foreground',
            isActive(current, path) && 'bg-secondary text-foreground',
          )}
        >
          <Icon size={16} strokeWidth={2} />
          {label}
        </Link>
      ))}
    </nav>
  )
}

export function MobileTabs() {
  const current = useAppPath()
  const href = useHref()
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-border bg-panel px-1 pb-[max(18px,env(safe-area-inset-bottom))] md:hidden">
      {MOBILE_TABS.map(({ path, label, short, icon: Icon }) => (
        <Link
          key={path}
          href={href(path)}
          className={cn(
            'flex flex-col items-center gap-1 pt-2 text-[10px] font-medium text-subtle no-underline hover:text-muted-foreground',
            isActive(current, path) && 'text-primary hover:text-primary',
          )}
        >
          <Icon size={20} strokeWidth={2} />
          <span>{short ?? label}</span>
        </Link>
      ))}
    </nav>
  )
}
