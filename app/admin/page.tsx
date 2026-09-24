import Link from 'next/link'
import { PageHeader } from '@/components/admin/page-header'
import { Card } from '@/components/ui/card'
import { Pill, StatusDot } from '@/components/ui/pill'
import { isClaudeConnected } from '@/lib/access'
import { connectorSummaries } from '@/lib/connectors/summary'
import { formatAgo } from '@/lib/format'
import { href } from '@/lib/prefix'
import { HUB_VERSION } from '@/lib/version'

export const dynamic = 'force-dynamic'

const TONE_LABEL = { ok: 'OK', warn: 'Не отвечает', err: 'Ошибка', muted: 'Не настроен' } as const

function formatToday(): string {
  const s = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' }).format(new Date())
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export default function DashboardPage() {
  const connected = isClaudeConnected()
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
          <Pill tone={connected ? 'ok' : 'muted'} dot>
            {connected ? 'Claude подключён' : 'Claude не подключён'}
          </Pill>
        }
        mobileAside={
          <Pill tone={connected ? 'ok' : 'muted'} dot>
            Claude
          </Pill>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3.5">
        {connectorSummaries().map((c) => {
          const label = c.configured && !c.enabled ? 'Выключен' : TONE_LABEL[c.tone]
          const detail = c.lastCheckAt ? `проверено ${formatAgo(c.lastCheckAt)}` : c.configured ? 'ещё не проверялся' : 'Настроить'
          return (
            <Link key={c.id} href={href(`/admin/connectors/${c.id}`)} className="text-inherit no-underline hover:text-inherit">
              <Card className={`flex h-full flex-col gap-1.5 p-3 md:gap-2.5 md:p-4 ${c.tone === 'warn' || c.tone === 'err' ? 'border-warn/40' : ''}`}>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold md:text-sm">{c.name}</span>
                  <span className="hidden md:inline-flex">
                    <Pill tone={c.tone}>{label}</Pill>
                  </span>
                  <StatusDot tone={c.tone} className="md:hidden" />
                </div>
                <div className="line-clamp-2 text-[13px] text-muted-foreground">{c.line}</div>
                <div className={`text-[11px] md:text-xs ${c.tone === 'warn' || c.tone === 'err' ? 'text-warn' : 'text-subtle'}`}>{detail}</div>
              </Card>
            </Link>
          )
        })}
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
          <StatusDot tone={connected ? 'ok' : 'muted'} />
          {connected ? 'Claude подключён' : 'Claude не подключён'}
        </span>
      </div>
    </>
  )
}
