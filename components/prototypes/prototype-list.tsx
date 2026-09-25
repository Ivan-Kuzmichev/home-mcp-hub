import Link from 'next/link'
import { Card } from '@/components/ui/card'
import { Pill } from '@/components/ui/pill'
import { expiryText } from '@/lib/connectors/prototypes'
import { formatAgo } from '@/lib/format'
import { href } from '@/lib/prefix'
import { isExpired, type Prototype } from '@/lib/prototypes/store'
import { cn } from '@/lib/utils'

function PinPill({ p }: { p: Prototype }) {
  if (p.version === 0) return <Pill tone="muted">загружается</Pill>
  if (isExpired(p)) return <Pill tone="err">истёк</Pill>
  return p.pinHash ? <Pill tone="warn">пин</Pill> : <Pill tone="muted">открыт</Pill>
}

/** Table on wide screens (unless `compact`), stacked rows on the phone and next to a card. */
export function PrototypeList({ items, selected, compact }: { items: Prototype[]; selected?: string; compact?: boolean }) {
  if (items.length === 0) {
    return <Card className="p-8 text-center text-[13px] text-subtle">Прототипов пока нет. Попроси Claude опубликовать страницу или загрузи HTML вручную.</Card>
  }
  return (
    <Card className="overflow-hidden">
      {!compact && (
        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full text-left text-[13px]">
            <thead className="text-xs text-subtle">
              <tr className="border-b border-divider">
                {['Название', 'Ссылка', 'Пин', 'Просмотры', 'Срок', 'Обновлён'].map((h) => (
                  <th key={h} className="px-4 py-2.5 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id} className={cn('border-b border-divider last:border-b-0 hover:bg-secondary/60', selected === p.id && 'bg-secondary')}>
                  <td className="max-w-[280px] px-4 py-3">
                    <Link href={href(`/admin/prototypes/${p.id}`)} className="block truncate font-medium text-foreground no-underline hover:text-primary">
                      {p.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">/p/{p.slug}</td>
                  <td className="px-4 py-3">
                    <PinPill p={p} />
                  </td>
                  <td className="px-4 py-3 font-mono text-muted-foreground">{p.views}</td>
                  <td className="px-4 py-3 text-muted-foreground">{expiryText(p)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{formatAgo(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={cn('flex flex-col', !compact && 'lg:hidden')}>
        {items.map((p) => (
          <Link
            key={p.id}
            href={href(`/admin/prototypes/${p.id}`)}
            className={cn('flex flex-col gap-1 border-b border-divider px-4 py-3 text-foreground no-underline last:border-b-0 hover:bg-secondary/60 hover:text-foreground', selected === p.id && 'bg-secondary')}
          >
            <span className="flex items-center justify-between gap-3">
              <span className="truncate font-medium">{p.title}</span>
              <PinPill p={p} />
            </span>
            <span className="flex gap-3 text-xs text-subtle">
              <span className="font-mono">/p/{p.slug}</span>
              <span>{p.views} просм.</span>
              <span>{expiryText(p)}</span>
            </span>
          </Link>
        ))}
      </div>
    </Card>
  )
}
