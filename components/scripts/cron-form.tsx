'use client'

import { useActionState, useState } from 'react'
import { createCronAction, type ActionState } from '@/app/admin/scripts/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TEXTAREA } from './tool-form'
import { t } from '@/components/i18n-client'

const CODE_EXAMPLE = `const status = await hub.tool('torrents_status', { filter: 'completed' })
await fetch('https://api.telegram.org/bot{{secret:TELEGRAM_TOKEN}}/sendMessage', {
  method: 'POST',
  body: { chat_id: '{{secret:TELEGRAM_CHAT_ID}}', text: status },
})`

export function CronForm() {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState<ActionState, FormData>(createCronAction, {})

  if (!open) {
    return (
      <div className="pt-3">
        <Button size="sm" onClick={() => setOpen(true)}>
          {t`Add cron`}
        </Button>
      </div>
    )
  }

  return (
    <form action={action} className="mt-3 flex flex-col gap-3 rounded-md border border-border bg-background p-3.5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cron-name">{t`Name`}</Label>
          <Input id="cron-name" name="name" required placeholder={t`Finished downloads to Telegram`} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cron-schedule">{t`Schedule`}</Label>
          <Input id="cron-schedule" name="schedule" required placeholder="0 9 * * *" className="font-mono" autoComplete="off" />
          <span className="text-xs text-subtle">{t`5 cron fields: minute hour day month weekday, hub time`}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cron-desc">{t`Description`}</Label>
        <Input id="cron-desc" name="description" placeholder={t`Sends the finished downloads every morning`} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cron-code">{t`Code`}</Label>
        <textarea id="cron-code" name="code" required rows={8} spellCheck={false} className={TEXTAREA} placeholder={CODE_EXAMPLE} />
        <span className="text-xs text-subtle">
          {t`Body of an async function:`} <span className="font-mono">fetch</span>, <span className="font-mono">{t`{{secret:NAME}}`}</span>,{' '}
          <span className="font-mono">hub.tool</span>, <span className="font-mono">state</span>, <span className="font-mono">log</span>{t`. A 30 s limit. The script turns on at once.`}
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
