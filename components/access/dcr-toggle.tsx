'use client'

import { useOptimistic, useTransition } from 'react'
import { setDcrAction } from '@/app/admin/access/actions'
import { Switch } from '@/components/ui/switch'
import { t } from '@/components/i18n-client'

export function DcrToggle({ allowed }: { allowed: boolean }) {
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useOptimistic(allowed)

  return (
    <div className="flex items-center gap-3">
      <Switch
        checked={value}
        disabled={pending}
        label={t`Allow registration of new clients`}
        onChange={(next) =>
          startTransition(async () => {
            setValue(next)
            const fd = new FormData()
            fd.set('allow', next ? '1' : '0')
            await setDcrAction(fd)
          })
        }
      />
      <div className="flex flex-col">
        <span className="font-medium">{t`New client registration (DCR)`}</span>
        <span className={value ? 'text-xs text-warn' : 'text-xs text-subtle'}>
          {value ? t`On · turns off by itself after “Allow”` : t`Off · turn on only while connecting`}
        </span>
      </div>
    </div>
  )
}
