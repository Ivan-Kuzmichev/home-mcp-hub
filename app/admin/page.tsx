import Link from 'next/link'
import { PageHeader } from '@/components/admin/page-header'
import { Card } from '@/components/ui/card'
import { Pill, StatusDot } from '@/components/ui/pill'
import { href } from '@/lib/prefix'
import { HUB_VERSION } from '@/lib/version'

export const dynamic = 'force-dynamic'

// Placeholders until connectors land (stage 3) and prototypes (stage 4).
const SERVICES = [
  { name: 'Jackett', unit: 'индексаторов', path: '/admin/connectors' },
  { name: 'qBittorrent', unit: 'МБ/с', path: '/admin/connectors' },
  { name: 'TorrServe', unit: 'в базе', path: '/admin/connectors' },
  { name: 'Прототипы', unit: 'опубликовано', path: '/admin/prototypes' },
]

function formatToday(): string {
  const s = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' }).format(new Date())
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Дашборд"
        subtitle={
          <>
            {formatToday()} · <span className="font-mono">v{HUB_VERSION}</span>
          </>
        }
        actions={
          <Pill tone="muted" dot>
            Claude не подключён
          </Pill>
        }
        mobileAside={
          <Pill tone="muted" dot>
            Claude
          </Pill>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3.5">
        {SERVICES.map((s) => (
          <Link key={s.name} href={href(s.path)} className="text-inherit no-underline hover:text-inherit">
            <Card className="flex h-full flex-col gap-1.5 p-3 md:gap-2.5 md:p-4">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold md:text-sm">{s.name}</span>
                <span className="hidden md:inline-flex">
                  <Pill tone="muted">Не настроен</Pill>
                </span>
                <StatusDot tone="muted" className="md:hidden" />
              </div>
              <div className="font-heading text-xl font-bold md:text-[22px]">
                — <span className="font-sans text-xs font-medium text-muted-foreground md:text-[13px]">{s.unit}</span>
              </div>
              <div className="text-[11px] text-subtle md:text-xs">Ещё не подключён</div>
            </Card>
          </Link>
        ))}
      </div>

      <Card className="flex flex-col gap-3.5 p-3.5 md:p-[18px]">
        <div className="flex items-center justify-between">
          <h2 className="text-sm md:text-[15px]">Последние вызовы Claude</h2>
          <Link href={href('/admin/activity')} className="text-xs no-underline">
            Журнал
          </Link>
        </div>
        <div className="py-6 text-center text-[13px] text-subtle">
          Claude ещё ничего не вызывал. Подключение настраивается на экране{' '}
          <Link href={href('/admin/access')} className="no-underline">
            «Доступ Claude»
          </Link>
          .
        </div>
      </Card>

      <div className="flex gap-3.5 px-0.5 text-xs text-muted-foreground md:hidden">
        <span className="flex items-center gap-1.5">
          <StatusDot tone="ok" />
          2FA
        </span>
        <span className="flex items-center gap-1.5">
          <StatusDot tone="muted" />
          Claude не подключён
        </span>
      </div>
    </>
  )
}
