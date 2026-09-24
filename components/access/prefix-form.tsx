'use client'

import { useActionState, useState } from 'react'
import { changePrefixAction, type PrefixState } from '@/app/admin/access/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function randomPrefix(length = 14): string {
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => BASE62[b % BASE62.length]).join('')
}

export function PrefixForm({ current, host }: { current: string; host: string }) {
  const [value, setValue] = useState(current)
  const [confirming, setConfirming] = useState(false)
  const [state, action, pending] = useActionState<PrefixState, FormData>(changePrefixAction, {})
  const changed = value !== current

  return (
    <form action={action} className="flex flex-col gap-2">
      <Label htmlFor="mcp-secret">Префикс пути</Label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="hidden font-mono text-[13px] text-subtle sm:inline">{host}/</span>
        <Input
          id="mcp-secret"
          name="prefix"
          className="min-w-0 flex-1 font-mono"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value.trim())
            setConfirming(false)
          }}
        />
        <Button
          onClick={() => {
            setValue(randomPrefix())
            setConfirming(false)
          }}
        >
          Сгенерировать
        </Button>
        {!confirming ? (
          <Button variant="primary" disabled={!changed} onClick={() => setConfirming(true)}>
            Применить
          </Button>
        ) : (
          <Button type="submit" variant="destructive" disabled={pending} className="bg-err text-background hover:bg-err/90">
            Точно сменить
          </Button>
        )}
      </div>
      {state.error && (
        <span role="alert" className="text-[13px] text-err">
          {state.error}
        </span>
      )}
      <span className={confirming ? 'text-xs text-warn' : 'text-xs text-subtle'}>
        После смены: Claude подключить заново (токены отзываются), админка откроется по новой ссылке, старая — 404. Прототипы не
        меняются.
      </span>
    </form>
  )
}
