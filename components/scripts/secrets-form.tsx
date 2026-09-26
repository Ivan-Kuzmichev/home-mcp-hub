'use client'

import { useActionState } from 'react'
import { deleteSecretAction, saveSecretAction, type ActionState } from '@/app/admin/scripts/actions'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/ui/confirm-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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
                  {s.description && ` · ${s.description}`} · изменён {s.updated}
                </span>
              </div>
              <ConfirmButton action={deleteSecretAction} fields={{ name: s.name }} label="Удалить" confirmLabel="Точно удалить" />
            </div>
          ))}
        </div>
      )}
      <form action={action} className="grid gap-3 rounded-md border border-border bg-background p-3.5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sec-name">Имя</Label>
          <Input id="sec-name" name="name" required placeholder="TELEGRAM_TOKEN" className="font-mono" autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sec-value">Значение — существующее: пусто, чтобы не менять</Label>
          <Input id="sec-value" name="value" type="password" autoComplete="new-password" className="font-mono" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sec-hosts">Куда можно отправлять</Label>
          <Input id="sec-hosts" name="hosts" required placeholder="api.telegram.org" className="font-mono" autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sec-desc">Описание для ассистента</Label>
          <Input id="sec-desc" name="description" placeholder="Токен бота уведомлений" />
        </div>
        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          <span className={state.error ? 'text-[13px] text-err' : 'text-[13px] text-ok'}>{state.error ?? state.ok}</span>
          <Button type="submit" size="sm" variant="primary" disabled={pending}>
            Сохранить секрет
          </Button>
        </div>
      </form>
      <p className="text-xs text-subtle">
        В коде скрипта секрет пишется как <span className="font-mono">{'{{secret:ИМЯ}}'}</span>. Хаб подставит значение только в запрос на указанные хосты — ни скрипт, ни ассистент значения не видят.
      </p>
    </div>
  )
}
