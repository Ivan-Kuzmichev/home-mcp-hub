import Link from 'next/link'
import { PageHeader } from '@/components/admin/page-header'
import { Card } from '@/components/ui/card'
import { Pill, StatusDot } from '@/components/ui/pill'
import { isClaudeConnected } from '@/lib/access'
import { connectorSummaries } from '@/lib/connectors/summary'
import { formatAgo, formatWhen } from '@/lib/format'
import { failedSignIns, lastToolCall, recentToolCalls } from '@/lib/journal'
import { resultText } from '@/lib/journal-view'
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
  const last = lastToolCall()
  const calls = recentToolCalls(5)
  const failed = failedSignIns(new Date(Date.now() - 86_400_000))
  const claudeText = connected ? `Claude подключён${last ? ` · вызов ${formatAgo(last.createdAt)}` : ''}` : 'Claude не подключён'
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
            {claudeText}
          </Pill>
        }
        mobileAside={
          <Pill tone={connected ? 'ok' : 'muted'} dot>
            Claude{connected && last ? ` · ${formatAgo(last.createdAt).replace(' назад', '')}` : ''}
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
        {calls.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-subtle">
            Claude ещё ничего не вызывал. Подключение настраивается на экране{' '}
            <Link href={href('/admin/access')} className="no-underline">
              «Доступ Claude»
            </Link>
            .
          </div>
        ) : (
          <div className="flex flex-col">
            {calls.map((c) => (
              <div key={c.id} className="flex items-center gap-3 border-b border-divider py-2.5 last:border-b-0">
                <span className="w-[88px] shrink-0 font-mono text-xs text-subtle">{formatWhen(c.createdAt).replace('сегодня ', '')}</span>
                <span className="w-[150px] shrink-0 truncate font-mono text-[13px]">{c.tool}</span>
                <span className="hidden min-w-0 flex-1 truncate text-muted-foreground md:block">{c.argsRedacted}</span>
                <span className="ml-auto shrink-0 md:ml-0">
                  <Pill tone={c.ok ? 'ok' : 'err'}>{c.ok ? `OK · ${((c.durationMs ?? 0) / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с` : resultText(c).slice(0, 24)}</Pill>
                </span>
              </div>
            ))}
          </div>
        )}
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

      {failed > 0 && (
        <Link href={`${href('/admin/activity')}?connector=auth&status=error&period=1`} className="no-underline">
          <Card className="border-warn/40 px-4 py-3 text-[13px] text-warn">
            {failed} {failed === 1 ? 'неудачная попытка' : failed < 5 ? 'неудачные попытки' : 'неудачных попыток'} входа за сутки — открыть журнал
          </Card>
        </Link>
      )}
    </>
  )
}
