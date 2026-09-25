'use client'

import { useOptimistic, useTransition } from 'react'
import { setAllowedClientsAction } from '@/app/admin/access/actions'
import { Switch } from '@/components/ui/switch'

type Preset = { id: string; name: string; hint: string; examples: string[] }

export function ClientsForm({ presets, allowed }: { presets: Preset[]; allowed: string[] }) {
  const [pending, startTransition] = useTransition()
  const [value, setValue] = useOptimistic(allowed)

  const toggle = (id: string, on: boolean) =>
    startTransition(async () => {
      const next = on ? [...value, id] : value.filter((x) => x !== id)
      setValue(next)
      await setAllowedClientsAction(next)
    })

  return (
    <div className="flex flex-col">
      {presets.map((p) => (
        <label key={p.id} className="flex cursor-pointer items-start gap-3 border-b border-divider py-3 last:border-b-0">
          <Switch checked={value.includes(p.id)} disabled={pending} label={p.name} onChange={(on) => toggle(p.id, on)} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">{p.name}</span>
            <span className="text-xs text-subtle">{p.hint}</span>
            <span className="truncate font-mono text-[11px] text-faint">{p.examples.join(' · ')}</span>
          </span>
        </label>
      ))}
    </div>
  )
}
