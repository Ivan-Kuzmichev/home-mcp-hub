import Link from 'next/link'
import { EnabledSwitch } from '@/components/connectors/enabled-switch'
import { Card } from '@/components/ui/card'
import { StatusDot } from '@/components/ui/pill'
import type { ConnectorSummary } from '@/lib/connectors/summary'
import { href } from '@/lib/prefix'
import { cn } from '@/lib/utils'

export function ConnectorList({ items, selected }: { items: ConnectorSummary[]; selected?: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((c) => (
        <Card key={c.id} className={cn('flex items-center gap-3 p-3.5 transition-colors', selected === c.id && 'border-primary/60 bg-secondary')}>
          <StatusDot tone={c.tone} />
          <Link href={href(`/admin/connectors/${c.id}`)} className="flex min-w-0 flex-1 flex-col text-foreground no-underline hover:text-foreground">
            <span className="font-semibold">{c.name}</span>
            <span className={cn('truncate text-xs', c.tone === 'warn' || c.tone === 'err' ? 'text-warn' : 'text-subtle')}>{c.line}</span>
          </Link>
          <EnabledSwitch id={c.id} name={c.name} enabled={c.enabled} disabled={!c.configured} />
        </Card>
      ))}
      <div className="px-1 pt-1 text-xs text-faint">Новые коннекторы появляются с обновлением хаба</div>
    </div>
  )
}
