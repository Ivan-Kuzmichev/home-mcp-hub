import { PageHeader } from '@/components/admin/page-header'
import { DcrToggle } from '@/components/access/dcr-toggle'
import { CidrForm } from '@/components/access/cidr-form'
import { PrefixForm } from '@/components/access/prefix-form'
import { Card } from '@/components/ui/card'
import { ConfirmButton } from '@/components/ui/confirm-button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Pill } from '@/components/ui/pill'
import { isClaudeConnected, listActiveTokens, listClients } from '@/lib/access'
import { CLAUDE_REDIRECT_URI, hubUrls, isMcpAvailable } from '@/lib/auth'
import { env } from '@/lib/env'
import { formatAgo, formatWhen, shortId } from '@/lib/format'
import { lastCallByClient, lastToolCall } from '@/lib/journal'
import { getPrefix } from '@/lib/prefix'
import { getAllowedCidrs, isDcrAllowed } from '@/lib/settings'
import { revokeClientAction, revokeTokenAction } from './actions'

export const dynamic = 'force-dynamic'

const STEPS = [
  'Включить регистрацию клиентов ниже',
  'Claude → Settings → Connectors → Add custom connector, вставить адрес MCP, OAuth-поля оставить пустыми',
  'Войти на открывшейся странице хаба и нажать «Разрешить»',
  'Попросить в чате hub_status — должен вернуться статус хаба',
  'Регистрация клиентов выключится сама после «Разрешить» — проверь переключатель',
]

export default function AccessPage() {
  const prefix = getPrefix()
  const host = new URL(env().BASE_URL).host
  const urls = hubUrls(prefix)
  const clients = listClients()
  const tokens = listActiveTokens()
  const connected = isClaudeConnected()
  const last = lastToolCall()
  const status = (
    <Pill tone={connected ? 'ok' : 'muted'} dot>
      {connected ? `Подключён${last ? ` · последний вызов ${formatAgo(last.createdAt)}` : ''}` : 'Не подключён'}
    </Pill>
  )

  return (
    <>
      <PageHeader title="Доступ Claude" subtitle="Адрес MCP-эндпоинта, OAuth-клиенты и выданные токены." actions={status} mobileAside={status} />

      {!isMcpAvailable() && (
        <Card className="border-warn/40 p-4 text-[13px] text-warn">
          BASE_URL без HTTPS: MCP-эндпоинт выключен. Claude подключается только к https-адресу — задай публичный URL из Pangolin.
        </Card>
      )}

      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Card className="flex flex-col gap-4 p-4 md:p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px]">Секретный префикс</h2>
            <Pill tone="muted">на всё, кроме /p/*</Pill>
          </div>
          <PrefixForm current={prefix} host={host} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-url">MCP server URL — вставить в Claude как есть</Label>
            <div className="flex gap-2">
              <Input id="mcp-url" className="font-mono" value={urls.resource} readOnly />
              <CopyButton value={urls.resource} />
            </div>
          </div>
          <dl className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-3 text-[13px]">
            <UrlRow label="Админка" value={`${host}/${prefix}/admin`} />
            <UrlRow label="OAuth и вход" value={`${host}/${prefix}/login`} />
            <UrlRow label="Прототипы — без префикса" value={`${host}/p/…`} />
            <div className="pt-1 text-xs text-subtle">
              Всё остальное отвечает пустым 404. Префикс прячет хаб от сканеров, но не заменяет OAuth и 2FA.
            </div>
          </dl>
        </Card>

        <Card className="flex flex-col gap-4 p-4 md:p-5">
          <h2 className="text-[15px]">Как подключить</h2>
          <ol className="flex flex-col gap-2.5">
            {STEPS.map((s, i) => (
              <li key={s} className="flex gap-2.5 text-[13px] text-muted-foreground">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-foreground">
                  {i + 1}
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          <div className="border-t border-divider pt-4">
            <DcrToggle allowed={isDcrAllowed()} />
          </div>
        </Card>
      </div>

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px]">OAuth-клиенты</h2>
          <span className="text-xs text-subtle">
            Разрешённый redirect: <span className="font-mono">{CLAUDE_REDIRECT_URI}</span>
          </span>
        </div>
        {clients.length === 0 ? (
          <Empty text="Клиентов нет. Claude зарегистрируется сам при подключении, пока включена регистрация." />
        ) : (
          <div className="flex flex-col">
            {clients.map((c) => (
              <div key={c.clientId} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-divider py-3 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{c.name ?? 'Без имени'}</span>
                  <span className="font-mono text-xs text-subtle">
                    {shortId(c.clientId)} · с {formatWhen(c.createdAt)}
                  </span>
                </div>
                <LastCall clientId={c.clientId} />
                <Pill tone={c.hasConsent ? 'ok' : 'muted'}>{c.hasConsent ? 'согласие выдано' : 'без согласия'}</Pill>
                <span className="w-24 font-mono text-xs text-muted-foreground">
                  {c.activeTokens} {c.activeTokens === 1 ? 'активный' : 'активных'}
                </span>
                <ConfirmButton action={revokeClientAction} fields={{ clientId: c.clientId }} label="Отозвать" />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px]">Активные токены</h2>
          <span className="text-xs text-subtle">access — 1 час, refresh — 30 дней</span>
        </div>
        {tokens.length === 0 ? (
          <Empty text="Активных токенов нет." />
        ) : (
          <div className="flex flex-col">
            {tokens.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-divider py-3 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span>
                    {t.clientName ?? 'Клиент'} · <span className="font-mono text-muted-foreground">rt_…{t.tokenTail}</span>
                  </span>
                  <span className="text-xs text-subtle">
                    выдан {formatWhen(t.createdAt)} · обновление до {formatWhen(t.expiresAt)}
                  </span>
                </div>
                <ConfirmButton action={revokeTokenAction} fields={{ id: t.id }} label="Отозвать" />
              </div>
            ))}
            <div className="pt-2 text-xs text-subtle">
              Отзыв токена останавливает обновление; текущий access-токен доживёт до часа. Чтобы отключить Claude сразу — отзови клиента.
            </div>
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px]">Ограничение по IP для MCP</h2>
          <span className="text-xs text-subtle">Пусто — пускать всех. Claude ходит из диапазона 160.79.104.0/21. Это защита в глубину, OAuth остаётся.</span>
        </div>
        <CidrForm initial={getAllowedCidrs()} trustProxy={env().TRUST_PROXY} />
      </Card>
    </>
  )
}

function LastCall({ clientId }: { clientId: string }) {
  const call = lastCallByClient(clientId)
  if (!call) return <span className="w-full text-xs text-subtle sm:w-auto">вызовов не было</span>
  return (
    <span className="w-full text-xs text-subtle sm:w-auto">
      {formatAgo(call.createdAt)} · <span className="font-mono">{call.tool}</span>
      {call.ip && <span className="font-mono"> · {call.ip}</span>}
    </span>
  )
}

function UrlRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4">
      <dt className="text-subtle">{label}</dt>
      <dd className="truncate font-mono text-xs leading-5 text-muted-foreground">{value}</dd>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="py-4 text-center text-[13px] text-subtle">{text}</div>
}
