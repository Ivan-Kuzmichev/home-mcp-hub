'use client'

import { useOptimistic, useTransition } from 'react'
import { setDcrAction } from '@/app/admin/access/actions'
import { Switch } from '@/components/ui/switch'

export function DcrToggle({ allowed }: { allowed: boolean }) {
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useOptimistic(allowed)

  return (
    <div className="flex items-center gap-3">
      <Switch
        checked={value}
        disabled={pending}
        label="Разрешить регистрацию новых клиентов"
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
        <span className="font-medium">Регистрация новых клиентов (DCR)</span>
        <span className={value ? 'text-xs text-warn' : 'text-xs text-subtle'}>
          {value ? 'Включена · выключится сама после «Разрешить»' : 'Выключена · включай только на время подключения'}
        </span>
      </div>
    </div>
  )
}
