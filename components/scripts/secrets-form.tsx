'use client'

import { useActionState } from 'react'
import { deleteSecretAction, saveSecretAction, type ActionState } from '@/app/admin/scripts/actions'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/ui/confirm-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { t } from '@/components/i18n-client'

type Secret = { name: string; hosts: string[]; description: string; updated: string }

export function SecretsForm({ secrets }: { secrets: Secret[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveSecretAction, {})
  return (
    <div className="flex flex-col gap-3">
      {secrets.length > 0 && (
        <div className="flex flex-col">
          {secrets.map((s) => (
            <div key={s.name} className="flex flex-wrap items-center gap-3 border-b border-divider py-2.5 last:border-b-0">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-mono text-[13px]">{s.name}</span>
                <span className="text-xs text-subtle">
                  → <span className="font-mono">{s.hosts.join(', ')}</span>
                  {s.description && ` · ${s.description}`} {t`· changed`} {s.updated}
                </span>
              </div>
              <ConfirmButton action={deleteSecretAction} fields={{ name: s.name }} label={t`Delete`} confirmLabel={t`Really delete`} />
            </div>
          ))}
        </div>
      )}
      <form action={action} className="grid gap-3 rounded-md border border-border bg-background p-3.5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sec-name">{t`Name`}</Label>
          <Input id="sec-name" name="name" required placeholder="TELEGRAM_TOKEN" className="font-mono" autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sec-value">{t`Value — for an existing one: empty to keep it`}</Label>
          <Input id="sec-value" name="value" type="password" autoComplete="new-password" className="font-mono" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sec-hosts">{t`Where it may be sent`}</Label>
          <Input id="sec-hosts" name="hosts" required placeholder="api.telegram.org" className="font-mono" autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sec-desc">{t`Description for the assistant`}</Label>
          <Input id="sec-desc" name="description" placeholder={t`Notification bot token`} />
        </div>
        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          <span className={state.error ? 'text-[13px] text-err' : 'text-[13px] text-ok'}>{state.error ?? state.ok}</span>
          <Button type="submit" size="sm" variant="primary" disabled={pending}>
            {t`Save secret`}
          </Button>
        </div>
      </form>
      <p className="text-xs text-subtle">
        {t`In script code a secret is written as`} <span className="font-mono">{t`{{secret:NAME}}`}</span>{t`. The hub substitutes the value only into requests to the given hosts — neither the script nor the assistant sees the value.`}
      </p>
    </div>
  )
}
