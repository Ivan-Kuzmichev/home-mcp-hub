import Link from 'next/link'
import { Card } from '@/components/ui/card'
import { Pill } from '@/components/ui/pill'
import { expiryText } from '@/lib/connectors/prototypes'
import { formatAgo } from '@/lib/format'
import { href } from '@/lib/prefix'
import { isExpired, type Prototype } from '@/lib/prototypes/store'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

function PinPill({ p }: { p: Prototype }) {
  if (p.version === 0) return <Pill tone="muted">{t`uploading`}</Pill>
  if (isExpired(p)) return <Pill tone="err">{t`expired`}</Pill>
  return p.pinHash ? <Pill tone="warn">{t`PIN`}</Pill> : <Pill tone="muted">{t`open`}</Pill>
}

/** Table on wide screens (unless `compact`), stacked rows on the phone and next to a card. */
export function PrototypeList({ items, selected, compact }: { items: Prototype[]; selected?: string; compact?: boolean }) {
  if (items.length === 0) {
    return <Card className="p-8 text-center text-[13px] text-subtle">{t`No prototypes yet. Ask the assistant to publish a page or upload HTML by hand.`}</Card>
  }
  return (
    <Card className="overflow-hidden">
      {!compact && (
        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full text-left text-[13px]">
            <thead className="text-xs text-subtle">
              <tr className="border-b border-divider">
                {[t`Title`, t`Link`, t`Pin`, t`Views`, t`Expires`, t`Updated`].map((h) => (
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
              <span>{p.views} {t`views`}</span>
              <span>{expiryText(p)}</span>
            </span>
          </Link>
        ))}
      </div>
    </Card>
  )
}
