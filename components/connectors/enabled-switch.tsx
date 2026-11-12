'use client'

import { useOptimistic, useTransition } from 'react'
import { setConnectorEnabledAction } from '@/app/admin/connectors/actions'
import { Switch } from '@/components/ui/switch'
import { t } from '@/components/i18n-client'

export function EnabledSwitch({ id, name, enabled, disabled }: { id: string; name: string; enabled: boolean; disabled?: boolean }) {
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useOptimistic(enabled)
  return (
    <Switch
      checked={value}
      disabled={disabled || pending}
      label={t`${name} is on`}
      onChange={(next) =>
        startTransition(async () => {
          setValue(next)
          await setConnectorEnabledAction(id, next)
        })
      }
    />
  )
}
