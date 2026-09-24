import Link from 'next/link'
import { ActivityFilters } from '@/components/activity/filters'
import { PageHeader } from '@/components/admin/page-header'
import { buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Pill } from '@/components/ui/pill'
import { plural } from '@/lib/connectors/format'
import { formatWhen } from '@/lib/format'
import { countJournal, queryJournal, type JournalRow } from '@/lib/journal'
import { connectorTag, filterFrom, formatDuration, JOURNAL_CONNECTOR_OPTIONS, PERIODS, resultText, toolLabel, type JournalSearch } from '@/lib/journal-view'
import { href } from '@/lib/prefix'
import { cn } from '@/lib/utils'

export const dynamic = 'force-dynamic'

const PAGE = 100

function Result({ row }: { row: JournalRow }) {
  const text = resultText(row)
  return (
    <Pill tone={row.ok ? 'ok' : 'err'} className="max-w-full">
      <span className="shrink-0">{row.ok ? 'OK' : 'Ошибка'}</span>
      {text && <span className="truncate font-normal opacity-80">{text}</span>}
    </Pill>
  )
}

function Tool({ row }: { row: JournalRow }) {
  const label = toolLabel(row)
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={cn('truncate', label.mono && 'font-mono text-[13px]')}>{label.text}</span>
      <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{connectorTag(row)}</span>
    </span>
  )
}

export default async function ActivityPage({ searchParams }: { searchParams: Promise<JournalSearch> }) {
  const sp = await searchParams
  const filter = filterFrom(sp)
  const limit = Math.min(1000, Math.max(PAGE, Number(sp.limit) || PAGE))
  const rows = queryJournal(filter, limit)
  const { total, errors } = countJournal(filter)
  const query = new URLSearchParams(Object.entries(sp).filter(([k, v]) => k !== 'limit' && typeof v === 'string' && v) as [string, string][])
  const more = new URLSearchParams(query)
  more.set('limit', String(limit + PAGE))

  return (
    <>
      <PageHeader
        title="Журнал"
        subtitle="Каждый вызов инструмента и каждый вход в админку. Аргументы обрезаны, секреты не пишутся."
        actions={
          <a href={`${href('/admin/activity/export')}?${query}`} className={buttonVariants({ size: 'sm' })}>
            Экспорт CSV
          </a>
        }
      />

      <div className="flex flex-col gap-2">
        <ActivityFilters connectors={JOURNAL_CONNECTOR_OPTIONS} periods={PERIODS} values={sp} />
        <span className="px-1 text-xs text-subtle">
          {total} {plural(total, ['запись', 'записи', 'записей'])} · {errors} {plural(errors, ['ошибка', 'ошибки', 'ошибок'])}
        </span>
      </div>

      {rows.length === 0 ? (
        <Card className="p-8 text-center text-[13px] text-subtle">Записей нет. Здесь появятся вызовы Claude и входы в админку.</Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full table-fixed text-left text-[13px]">
              <colgroup>
                <col className="w-[120px]" />
                <col className="w-[240px]" />
                <col />
                <col className="w-[280px]" />
                <col className="w-[90px]" />
              </colgroup>
              <thead className="text-xs text-subtle">
                <tr className="border-b border-divider">
                  {['Время', 'Инструмент', 'Аргументы', 'Результат', 'Ответ'].map((h) => (
                    <th key={h} className="px-4 py-2.5 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-divider align-top last:border-b-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-subtle">{formatWhen(r.createdAt)}</td>
                    <td className="px-4 py-2.5">
                      <Tool row={r} />
                    </td>
                    <td className="px-4 py-2.5 break-words text-muted-foreground">{r.argsRedacted}</td>
                    <td className="px-4 py-2.5">
                      <Result row={r} />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{formatDuration(r.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col lg:hidden">
            {rows.map((r) => (
              <div key={r.id} className="flex flex-col gap-1.5 border-b border-divider px-4 py-3 last:border-b-0">
                <div className="flex items-center justify-between gap-3">
                  <Tool row={r} />
                  <span className="shrink-0 font-mono text-[11px] text-subtle">{formatWhen(r.createdAt)}</span>
                </div>
                <span className="line-clamp-2 text-xs text-muted-foreground">{r.argsRedacted}</span>
                <div className="flex items-center justify-between gap-3">
                  <Result row={r} />
                  <span className="shrink-0 font-mono text-[11px] text-subtle">{formatDuration(r.durationMs)}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {rows.length < total && (
        <Link href={`?${more}`} className={cn(buttonVariants({ size: 'sm' }), 'self-center no-underline')}>
          Показать ещё
        </Link>
      )}
    </>
  )
}
