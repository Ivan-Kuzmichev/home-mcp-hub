'use client'

import { useState, useTransition } from 'react'
import { approveAction, rejectAction } from '@/app/admin/scripts/actions'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/ui/pill'

export type ReviewData = {
  id: string
  name: string
  description: string
  schedule: string
  code: string
  codeHash: string
  previousCode: string | null
  secretsUsed: string[]
  hosts: string[]
  updatedAgo: string
}

export function ReviewCard({ data }: { data: ReviewData }) {
  const [pending, start] = useTransition()
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  return (
    <Card className="flex flex-col gap-3 border-warn/40 p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-semibold">{data.name}</span>
          <span className="text-xs text-subtle">
            {data.previousCode ? 'Изменение кода' : 'Новый скрипт'} · <span className="font-mono">{data.schedule}</span> · {data.updatedAgo}
          </span>
        </div>
        <Pill tone="warn">ждёт одобрения</Pill>
      </div>
      {data.description && <p className="text-[13px] text-muted-foreground">{data.description}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-subtle">
        <span>
          Секреты: {data.secretsUsed.length ? <span className="font-mono text-muted-foreground">{data.secretsUsed.join(', ')}</span> : 'не использует'}
        </span>
        <span>
          Запросы к: {data.hosts.length ? <span className="font-mono text-muted-foreground">{data.hosts.join(', ')}</span> : 'не видно в коде'}
        </span>
      </div>
      <pre className="max-h-96 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-5 text-foreground">{data.code}</pre>
      {data.previousCode && (
        <details className="text-[13px]">
          <summary className="cursor-pointer text-muted-foreground">Одобренная ранее версия</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-5 text-subtle">{data.previousCode}</pre>
        </details>
      )}
      {rejecting && <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Причина — ассистент её увидит (необязательно)" />}
      {msg && <span className={msg.ok ? 'text-[13px] text-ok' : 'text-[13px] text-err'}>{msg.text}</span>}
      <div className="flex flex-wrap justify-end gap-2">
        {!rejecting ? (
          <Button size="sm" variant="destructive" disabled={pending} onClick={() => setRejecting(true)}>
            Отклонить
          </Button>
        ) : (
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await rejectAction(data.id, data.codeHash, reason)
                setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.ok ?? '' })
              })
            }
          >
            Точно отклонить
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await approveAction(data.id, data.codeHash)
              setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.ok ?? '' })
            })
          }
        >
          Одобрить и включить
        </Button>
      </div>
    </Card>
  )
}
