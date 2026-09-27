'use client'

import { Lock } from 'lucide-react'
import { useState, useTransition } from 'react'
import { setConnectorSharedAction } from '@/app/admin/scripts/actions'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

type Item = {
  id: string
  name: string
  active: boolean
  shared: boolean
  host: string | null
  entries: { name: string; label: string; secret: boolean }[]
}

export function ConnectorSharing({ items, localOff }: { items: Item[]; localOff: boolean }) {
  const [state, setState] = useState(() => Object.fromEntries(items.map((i) => [i.id, i.shared])))
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const anyOn = Object.values(state).some(Boolean)

  if (items.length === 0) return <div className="py-2 text-[13px] text-subtle">Настроенных коннекторов пока нет.</div>

  return (
    <div className="flex flex-col">
      {items.map((i) => (
        <div key={i.id} className="flex flex-col gap-2 border-b border-divider py-3 last:border-b-0">
          <label className="flex cursor-pointer items-center gap-3">
            <Switch
              checked={state[i.id] ?? false}
              label={i.name}
              disabled={pending}
              onChange={(on) => {
                setState((s) => ({ ...s, [i.id]: on }))
                setError(null)
                start(async () => {
                  const r = await setConnectorSharedAction(i.id, on)
                  if (r.error) {
                    setError(r.error)
                    setState((s) => ({ ...s, [i.id]: !on }))
                  }
                })
              }}
            />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{i.name}</span>
              <span className="text-xs text-subtle">
                {i.active ? (i.host ? <>секреты уходят только на <span className="font-mono">{i.host}</span></> : 'адрес не задан') : 'коннектор выключен — скрипты значения не получат'}
              </span>
            </span>
          </label>
          <div className={cn('flex flex-wrap gap-1.5 pl-[52px]', !state[i.id] && 'opacity-50')}>
            {i.entries.map((e) => (
              <span key={e.name} title={e.label} className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {e.secret && <Lock size={11} />}
                {e.name}
              </span>
            ))}
          </div>
        </div>
      ))}
      {error && <span className="pt-2 text-[13px] text-err">{error}</span>}
      {anyOn && localOff && (
        <span className="pt-2 text-xs text-warn">
          Доступ скриптов к локальной сети выключен — до сервисов по адресам вроде http://jackett:9117 они не достучатся. Включается в Коннекторы → Cron-скрипты.
        </span>
      )}
    </div>
  )
}
