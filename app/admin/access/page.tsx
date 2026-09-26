import { PageHeader } from '@/components/admin/page-header'
import { DcrToggle } from '@/components/access/dcr-toggle'
import { CidrForm } from '@/components/access/cidr-form'
import { ClientsForm } from '@/components/access/clients-form'
import { ConnectTabs } from '@/components/access/connect-tabs'
import { Card } from '@/components/ui/card'
import { ConfirmButton } from '@/components/ui/confirm-button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Pill } from '@/components/ui/pill'
import { isMcpConnected, listActiveTokens, listClients } from '@/lib/access'
import { hubUrls, isMcpAvailable } from '@/lib/auth'
import { CLIENT_PRESETS, getAllowedClients } from '@/lib/oauth-clients'
import { env } from '@/lib/env'
import { formatAgo, formatWhen, shortId } from '@/lib/format'
import { lastCallByClient, lastToolCall } from '@/lib/journal'
import { getPrefix } from '@/lib/prefix'
import { getAllowedCidrs, isDcrAllowed } from '@/lib/settings'
import { revokeClientAction, revokeTokenAction } from './actions'

export const dynamic = 'force-dynamic'

export default function AccessPage() {
  const prefix = getPrefix()
  const urls = hubUrls(prefix)
  const clients = listClients()
  const tokens = listActiveTokens()
  const connected = isMcpConnected()
  const last = lastToolCall()
  const status = (
    <Pill tone={connected ? 'ok' : 'muted'} dot>
      {connected ? `Подключён${last ? ` · последний вызов ${formatAgo(last.createdAt)}` : ''}` : 'Не подключён'}
    </Pill>
  )

  return (
    <>
      <PageHeader title="MCP доступ" subtitle="Подключение ИИ-ассистентов по MCP: адрес, разрешённые клиенты, OAuth-клиенты и токены." actions={status} mobileAside={status} />

      {!isMcpAvailable() && (
        <Card className="border-warn/40 p-4 text-[13px] text-warn">
          BASE_URL без HTTPS: MCP-эндпоинт выключен. Claude и ChatGPT подключаются только к https-адресу — задай публичный URL из Pangolin.
        </Card>
      )}

      <Card className="flex flex-col gap-4 p-4 md:p-5">
        <h2 className="text-[15px]">Как подключить</h2>
        <div className="flex flex-col gap-2">
          <Label htmlFor="mcp-url">MCP server URL — вставить в клиент как есть</Label>
          <div className="flex gap-2">
            <Input id="mcp-url" className="font-mono" value={urls.resource} readOnly />
            <CopyButton value={urls.resource} />
          </div>
        </div>
        <ConnectTabs />
        <div className="border-t border-divider pt-4">
          <DcrToggle allowed={isDcrAllowed()} />
        </div>
      </Card>

      <Card className="flex flex-col gap-1 p-4 md:p-5">
        <div className="flex flex-col gap-0.5 pb-1">
          <h2 className="text-[15px]">Разрешённые клиенты</h2>
          <span className="text-xs text-subtle">
            Кто может зарегистрироваться, пока регистрация включена. Проверяется по redirect URI; отказы видны в журнале.
          </span>
        </div>
        <ClientsForm presets={CLIENT_PRESETS.map(({ id, name, hint, examples }) => ({ id, name, hint, examples }))} allowed={getAllowedClients()} />
      </Card>

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px]">OAuth-клиенты</h2>
          <span className="text-xs text-subtle">Каждое подключение регистрирует своего клиента</span>
        </div>
        {clients.length === 0 ? (
          <Empty text="Клиентов нет. Клиент (Claude, ChatGPT) зарегистрируется сам при подключении, пока включена регистрация." />
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
              Отзыв токена останавливает обновление; текущий access-токен доживёт до часа. Чтобы отключить клиента сразу — отзови его в списке выше.
            </div>
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px]">Ограничение по IP для MCP</h2>
          <span className="text-xs text-subtle">Пусто — пускать всех. Claude (Anthropic) ходит из 160.79.104.0/21, у ChatGPT адреса OpenAI. Это защита в глубину, OAuth остаётся.</span>
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

function Empty({ text }: { text: string }) {
  return <div className="py-4 text-center text-[13px] text-subtle">{text}</div>
}
