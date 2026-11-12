'use client'

import { t, tr } from '@/components/i18n-client'
import { useActionState, useState } from 'react'
import { createToolAction, type ActionState } from '@/app/admin/scripts/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export const TEXTAREA =
  'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] leading-5 text-foreground placeholder:text-faint focus-visible:border-primary focus-visible:outline-none'

const PARAMS_EXAMPLE = `[
  { "name": "city", "type": "string", "description": "City" },
  { "name": "days", "type": "number", "required": false }
]`

const CODE_EXAMPLE = `const r = await fetch('https://wttr.in/' + encodeURIComponent(args.city) + '?format=j1')
const d = await r.json()
return d.current_condition[0].temp_C + '°C'`

export function ToolForm() {
  const [open, setOpen] = useState(false)
  const [readOnly, setReadOnly] = useState(true)
  const [state, action, pending] = useActionState<ActionState, FormData>(createToolAction, {})

  if (!open) {
    return (
      <div className="pt-3">
        <Button size="sm" onClick={() => setOpen(true)}>
          {t`Add tool`}
        </Button>
      </div>
    )
  }

  return (
    <form action={action} className="mt-3 flex flex-col gap-3 rounded-md border border-border bg-background p-3.5">
      <input type="hidden" name="readOnly" value={readOnly ? 'on' : ''} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tool-name">{t`Name`}</Label>
          <Input id="tool-name" name="name" required placeholder="weather → my_weather" className="font-mono" autoComplete="off" />
        </div>
        <label className="flex cursor-pointer items-start gap-3 sm:pt-6">
          <Switch checked={readOnly} label={t`Read only`} onChange={setReadOnly} />
          <span className="flex flex-col">
            <span>{t`Read only`}</span>
            <span className="text-xs text-subtle">{t`Turn off if the tool changes something: sends messages, writes to services`}</span>
          </span>
        </label>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tool-desc">{t`Description for the assistant`}</Label>
        <textarea id="tool-desc" name="description" required rows={2} className={TEXTAREA} placeholder={t`The current weather in a city. Call when asked about the weather.`} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tool-params">{t`Parameters (JSON)`}</Label>
        <textarea id="tool-params" name="params" rows={4} spellCheck={false} className={TEXTAREA} placeholder={tr(PARAMS_EXAMPLE)} />
        <span className="text-xs text-subtle">
          {t`type — string, number, boolean or enum (with an options list); required is true by default. Empty — no parameters.`}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tool-code">{t`Code`}</Label>
        <textarea id="tool-code" name="code" required rows={8} spellCheck={false} className={TEXTAREA} placeholder={CODE_EXAMPLE} />
        <span className="text-xs text-subtle">
          {t`Arguments come in`} <span className="font-mono">args</span>{t`, the answer goes through`} <span className="font-mono">return</span>{t`. Secrets, network and`}{' '}
          <span className="font-mono">hub.tool</span> {t`— as for scripts, a 25 s limit.`}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={state.error ? 'text-[13px] text-err' : 'text-[13px] text-ok'}>{state.error ?? state.ok}</span>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setOpen(false)}>
            {t`Cancel`}
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={pending}>
            {pending ? t`Saving…` : t`Add`}
          </Button>
        </div>
      </div>
    </form>
  )
}
