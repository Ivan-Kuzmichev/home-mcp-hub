'use client'

import { LogOut } from 'lucide-react'
import { useHref } from '@/components/prefix-provider'
import { useAuthClient } from '@/lib/auth-client'
import { cn } from '@/lib/utils'
import { t } from '@/components/i18n-client'

export function SignOutButton({ className, withLabel }: { className?: string; withLabel?: boolean }) {
  const auth = useAuthClient()
  const href = useHref()
  return (
    <button
      type="button"
      aria-label={t`Sign out`}
      className={cn('flex cursor-pointer items-center gap-2 text-subtle hover:text-foreground', className)}
      onClick={async () => {
        await auth.signOut()
        window.location.assign(href('/login'))
      }}
    >
      <LogOut size={16} />
      {withLabel && <span>{t`Sign out`}</span>}
    </button>
  )
}
