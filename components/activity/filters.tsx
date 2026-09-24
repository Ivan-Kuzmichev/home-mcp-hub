'use client'

import { Input } from '@/components/ui/input'

type Option = { value: string; label: string }

const selectClass = 'h-9 rounded-md border border-input bg-background px-2.5 text-[13px] text-foreground'

/** GET form that submits itself on every change; the URL keeps the filter. */
export function ActivityFilters({
  connectors,
  periods,
  values,
}: {
  connectors: Option[]
  periods: Option[]
  values: { connector?: string; status?: string; period?: string; q?: string }
}) {
  const submit = (e: React.ChangeEvent<HTMLSelectElement>) => e.currentTarget.form?.requestSubmit()
  return (
    <form className="flex flex-wrap items-center gap-2" method="get">
      <select name="connector" aria-label="Коннектор" defaultValue={values.connector ?? ''} onChange={submit} className={selectClass}>
        <option value="">Все коннекторы</option>
        {connectors.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select name="status" aria-label="Статус" defaultValue={values.status ?? ''} onChange={submit} className={selectClass}>
        <option value="">Все статусы</option>
        <option value="ok">Успешные</option>
        <option value="error">Ошибки</option>
      </select>
      <select name="period" aria-label="Период" defaultValue={values.period ?? '7'} onChange={submit} className={selectClass}>
        {periods.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Input name="q" type="search" defaultValue={values.q} placeholder="Поиск по инструменту или аргументам" className="h-9 min-w-[200px] flex-1 text-[13px]" />
    </form>
  )
}
