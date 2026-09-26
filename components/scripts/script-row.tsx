'use client'

import { useState, useTransition } from 'react'
import { deleteScriptAction, runNowAction, setEnabledAction } from '@/app/admin/scripts/actions'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/ui/confirm-button'
import { Pill, type PillTone } from '@/components/ui/pill'
import { Switch } from '@/components/ui/switch'

export type RunView = { id: number; when: string; trigger: string; ok: boolean; duration: string; error: string | null; output: string | null; logs: string | null }

export type ScriptView = {
  id: string
  name: string
  description: string
  schedule: string
  status: string
  statusLabel: string
  tone: PillTone
  approved: boolean
  enabled: boolean
  next: string | null
  last: string | null
  rejectReason: string | null
  code: string
  runs: RunView[]
}

export function ScriptRow({ s }: { s: ScriptView }) {
  const [pending, start] = useTransition()
  const [enabled, setEnabled] = useState(s.enabled)
  const [result, setResult] = useState<{ ok: boolean; text: string; output?: string } | null>(null)

  return (
    <div className="flex flex-col gap-2 border-b border-divider py-3.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-3">
        <Switch
          checked={enabled}
          disabled={pending || !s.approved}
          label={`${s.name} включён`}
          onChange={(v) =>
            start(async () => {
              setEnabled(v)
              const r = await setEnabledAction(s.id, v)
              if (r.error) {
                setEnabled(!v)
                setResult({ ok: false, text: r.error })
              }
            })
          }
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">
            {s.name} <span className="font-mono text-xs text-subtle">{s.id}</span>
          </span>
          <span className="text-xs text-subtle">
            <span className="font-mono">{s.schedule}</span>
            {s.next && ` · следующий ${s.next}`}
            {s.last && ` · последний ${s.last}`}
          </span>
        </div>
        <Pill tone={s.tone}>{s.statusLabel}</Pill>
        <Button
          size="sm"
          disabled={pending || !s.approved}
          onClick={() =>
            start(async () => {
              const r = await runNowAction(s.id)
              setResult(r.error ? { ok: false, text: r.error, output: r.output } : { ok: true, text: r.ok ?? '', output: r.output })
            })
          }
        >
          Запустить
        </Button>
        <ConfirmButton action={deleteScriptAction} fields={{ id: s.id }} label="Удалить" confirmLabel="Точно удалить" />
      </div>
      {s.description && <p className="text-[13px] text-muted-foreground">{s.description}</p>}
      {s.rejectReason && <p className="text-[13px] text-err">Отклонён: {s.rejectReason}</p>}
      {result && (
        <div className={`rounded-md border border-border bg-background p-2.5 text-xs ${result.ok ? 'text-ok' : 'text-err'}`}>
          {result.text}
          {result.output && <pre className="mt-1.5 max-h-48 overflow-auto font-mono whitespace-pre-wrap text-muted-foreground">{result.output}</pre>}
        </div>
      )}
      <details className="text-[13px]">
        <summary className="cursor-pointer text-muted-foreground">Код и запуски ({s.runs.length})</summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-5">{s.code}</pre>
        {s.runs.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            {s.runs.map((r) => (
              <div key={r.id} className="rounded-md border border-divider p-2 text-xs">
                <span className={r.ok ? 'text-ok' : 'text-err'}>{r.ok ? 'ок' : 'ошибка'}</span>
                <span className="text-subtle">
                  {' '}
                  · {r.when} · {r.trigger} · {r.duration}
                </span>
                {r.error && <div className="mt-1 text-err">{r.error}</div>}
                {r.output && <pre className="mt-1 max-h-32 overflow-auto font-mono whitespace-pre-wrap text-muted-foreground">{r.output}</pre>}
                {r.logs && <pre className="mt-1 max-h-32 overflow-auto font-mono whitespace-pre-wrap text-subtle">{r.logs}</pre>}
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  )
}
