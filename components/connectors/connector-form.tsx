'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { saveConnectorAction, testConnectorAction, type FormValues } from '@/app/admin/connectors/actions'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Pill } from '@/components/ui/pill'
import { Switch } from '@/components/ui/switch'
import type { FieldDescriptor, ToolDescriptor } from '@/lib/connectors/form'
import type { TestResult } from '@/lib/connectors/types'
import { cn } from '@/lib/utils'

type Props = {
  id: string
  name: string
  description: string
  docsUrl?: string
  fields: FieldDescriptor[]
  tools: ToolDescriptor[]
  disabledTools: string[]
  configured: boolean
  lastCheck: { ok: boolean; note: string; ago: string } | null
  hubNetworks: { address: string; cidr: string }[]
  backHref: string
}

type CheckState = { result: TestResult; at: 'now' } | null

export function ConnectorForm(props: Props) {
  const { id, fields, tools } = props
  const [values, setValues] = useState<FormValues>(() => Object.fromEntries(fields.map((f) => [f.name, f.value])))
  const [off, setOff] = useState<Set<string>>(() => new Set(props.disabledTools))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [check, setCheck] = useState<CheckState>(null)
  const [saved, setSaved] = useState(false)
  const [testing, startTest] = useTransition()
  const [saving, startSave] = useTransition()

  const set = (name: string, value: string | boolean) => {
    setValues((v) => ({ ...v, [name]: value }))
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== name)))
    setSaved(false)
  }

  const visible = (f: FieldDescriptor) => !f.showWhen || f.showWhen.equals.includes(String(values[f.showWhen.field]))
  const connection = fields.filter((f) => f.section !== 'defaults' && visible(f))
  const defaults = fields.filter((f) => f.section === 'defaults' && visible(f))

  const onTest = () =>
    startTest(async () => {
      const r = await testConnectorAction(id, values)
      if (!r.ok) return setErrors(r.errors)
      setCheck({ result: r.test, at: 'now' })
    })

  const onSave = () =>
    startSave(async () => {
      const r = await saveConnectorAction(id, values, [...off])
      if (!r.ok) return setErrors(r.errors)
      setCheck({ result: r.test, at: 'now' })
      setSaved(true)
      // Secrets were stored: clear them from the form, they now show as «задан».
      setValues((v) => Object.fromEntries(Object.entries(v).map(([k, val]) => [k, fields.find((f) => f.name === k)?.secret ? '' : val])))
    })

  const status = check ? { ok: check.result.ok, text: check.result.ok ? `Соединение есть · ${check.result.summary}` : check.result.summary } : props.lastCheck
    ? { ok: props.lastCheck.ok, text: `${props.lastCheck.ok ? 'Соединение есть' : 'Ошибка'} · проверено ${props.lastCheck.ago}` }
    : null

  return (
    <Card className="flex flex-col gap-5 p-4 pb-24 md:p-5 md:pb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-lg">{props.name}</h2>
          <span className="text-[13px] text-subtle">
            {props.description}
            {props.docsUrl && (
              <>
                {' · '}
                <a href={props.docsUrl} target="_blank" rel="noreferrer noopener" className="no-underline">
                  документация API
                </a>
              </>
            )}
          </span>
        </div>
        {status && (
          <Pill tone={status.ok ? 'ok' : 'warn'} dot>
            {status.text}
          </Pill>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {connection.map((f) => (
          <FieldControl key={f.name} field={f} value={values[f.name]} error={errors[f.name]} onChange={set} hubNetworks={props.hubNetworks} />
        ))}
        {defaults.length > 0 && <div className="border-t border-divider" />}
        {defaults.map((f) => (
          <FieldControl key={f.name} field={f} value={values[f.name]} error={errors[f.name]} onChange={set} hubNetworks={props.hubNetworks} />
        ))}
        {errors._ && <div className="text-[13px] text-err">{errors._}</div>}
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">Проверка соединения</span>
          <Button size="sm" onClick={onTest} disabled={testing || saving}>
            {testing ? 'Проверяю…' : 'Проверить'}
          </Button>
        </div>
        {check && (
          <div className={cn('flex flex-wrap gap-x-4 gap-y-1 text-[13px]', check.result.ok ? 'text-muted-foreground' : 'text-err')}>
            <span className={check.result.ok ? 'text-ok' : undefined}>
              {check.result.ok ? '✓' : '✕'} {check.result.summary}
            </span>
            {check.result.details.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-medium">Инструменты для Claude</span>
        <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {tools.map((t) => (
            <label key={t.name} className="flex cursor-pointer items-center gap-2.5">
              <Switch
                checked={!off.has(t.name)}
                label={t.name}
                onChange={(on) => {
                  setOff((s) => {
                    const next = new Set(s)
                    if (on) next.delete(t.name)
                    else next.add(t.name)
                    return next
                  })
                  setSaved(false)
                }}
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-[13px]">{t.name}</span>
                <span className="truncate text-xs text-subtle">
                  {t.title}
                  {t.destructive ? ' · с подтверждением' : t.readOnly ? ' · только чтение' : ''}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-[calc(62px+max(18px,env(safe-area-inset-bottom)))] z-10 flex gap-2.5 border-t border-border bg-panel px-4 py-3 md:static md:justify-end md:border-0 md:bg-transparent md:p-0">
        {saved && <span className="hidden self-center text-[13px] text-ok md:inline">Сохранено</span>}
        <Link href={props.backHref} className="flex-1 md:flex-none">
          <Button className="w-full">Отмена</Button>
        </Link>
        <Button variant="primary" className="flex-1 md:flex-none" onClick={onSave} disabled={saving}>
          {saving ? 'Сохраняю…' : saved ? 'Сохранено' : 'Сохранить'}
        </Button>
      </div>
    </Card>
  )
}

function FieldControl({
  field: f,
  value,
  error,
  onChange,
  hubNetworks,
}: {
  field: FieldDescriptor
  value: string | boolean | undefined
  error?: string
  onChange: (name: string, value: string | boolean) => void
  hubNetworks: { address: string; cidr: string }[]
}) {
  const id = `f-${f.name}`

  if (f.widget === 'switch') {
    return (
      <label className="flex cursor-pointer items-center gap-3">
        <Switch checked={value === true} label={f.label} onChange={(v) => onChange(f.name, v)} />
        <span className="flex flex-col">
          <span>{f.label}</span>
          {f.help && <span className="text-xs text-subtle">{f.help}</span>}
        </span>
      </label>
    )
  }

  if (f.widget === 'segmented' && f.options) {
    const current = f.options.find((o) => o.value === value)
    return (
      <div className="flex flex-col gap-1.5">
        <Label>{f.label}</Label>
        <div role="radiogroup" aria-label={f.label} className="grid auto-cols-fr grid-flow-col gap-1 rounded-md border border-border bg-background p-1">
          {f.options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === value}
              onClick={() => onChange(f.name, o.value)}
              className={cn(
                'cursor-pointer rounded-sm px-2 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground',
                o.value === value && 'bg-secondary text-foreground',
              )}
            >
              <span className="hidden sm:inline">{o.label}</span>
              <span className="sm:hidden">{o.short ?? o.label}</span>
            </button>
          ))}
        </div>
        {current?.help && (
          <div className="rounded-md bg-secondary/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {current.help}
            {current.showHubNetwork && hubNetworks.length > 0 && (
              <div className="mt-1">
                Адрес хаба:{' '}
                {hubNetworks.map((n, i) => (
                  <span key={n.address}>
                    {i > 0 && ', '}
                    <span className="font-mono">{n.address}</span> → подсеть <span className="font-mono">{n.cidr}</span>
                  </span>
                ))}
                . Секреты для этого режима не нужны.
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const placeholder = f.secret && f.secretSet ? 'задан · оставь пустым, чтобы не менять' : f.placeholder
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="flex items-center gap-2">
        {f.label}
        {f.secret && f.secretSet && <span className="text-[11px] font-normal text-ok">задан</span>}
      </Label>
      <Input
        id={id}
        type={f.secret ? 'password' : f.widget === 'url' ? 'url' : f.widget === 'number' ? 'number' : 'text'}
        inputMode={f.widget === 'number' ? 'numeric' : undefined}
        autoComplete={f.secret ? 'new-password' : 'off'}
        spellCheck={false}
        className={f.mono ? 'font-mono' : undefined}
        placeholder={placeholder}
        value={typeof value === 'string' ? value : ''}
        aria-invalid={!!error}
        onChange={(e) => onChange(f.name, e.target.value)}
      />
      {error ? <span className="text-xs text-err">{error}</span> : f.help && <span className="text-xs text-subtle">{f.help}</span>}
    </div>
  )
}
