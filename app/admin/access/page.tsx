import { t, tr, trc } from '@/lib/i18n'
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
import { requireAdmin } from '@/lib/session'

export const dynamic = 'force-dynamic'

export default async function AccessPage() {
  // Pages render in parallel with the layout: each one checks the session itself.
  await requireAdmin()
  const prefix = getPrefix()
  const urls = hubUrls(prefix)
  const clients = listClients()
  const tokens = listActiveTokens()
  const connected = isMcpConnected()
  const last = lastToolCall()
  const status = (
    <Pill tone={connected ? 'ok' : 'muted'} dot>
      {connected ? t`Connected${last ? t` · last call ${formatAgo(last.createdAt)}` : ''}` : t`Not connected`}
    </Pill>
  )

  return (
    <>
      <PageHeader
        title={t`MCP access`}
        subtitle={t`Connecting AI assistants over MCP: the address, allowed clients, OAuth clients and tokens.`}
        actions={status}
        mobileAside={
          // Phone: the short form, as on the dashboard, so the title keeps its room.
          <Pill tone={connected ? 'ok' : 'muted'} dot>
            MCP{connected && last ? ` · ${formatAgo(last.createdAt).replace(t` ago`, '')}` : ''}
          </Pill>
        }
      />

      {!isMcpAvailable() && (
        <Card className="border-warn/40 p-4 text-[13px] text-warn">
          {t`BASE_URL has no HTTPS: the MCP endpoint is off. Claude and ChatGPT connect only to an https address — set the public URL from Pangolin.`}
        </Card>
      )}

      <Card className="flex flex-col gap-4 p-4 md:p-5">
        <h2 className="text-[15px]">{t`How to connect`}</h2>
        <div className="flex flex-col gap-2">
          <Label htmlFor="mcp-url">{t`MCP server URL — paste into the client as is`}</Label>
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
          <h2 className="text-[15px]">{t`Allowed clients`}</h2>
          <span className="text-xs text-subtle">
            {t`Who may register while registration is on. Checked by redirect URI; refusals show in the log.`}
          </span>
        </div>
        <ClientsForm presets={CLIENT_PRESETS.map(({ id, name, hint, examples }) => ({ id, name: tr(name), hint: tr(hint), examples }))} allowed={getAllowedClients()} />
      </Card>

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px]">{t`OAuth clients`}</h2>
          <span className="text-xs text-subtle">{t`Every connection registers its own client`}</span>
        </div>
        {clients.length === 0 ? (
          <Empty text={t`No clients. A client (Claude, ChatGPT) registers itself when connecting while registration is on.`} />
        ) : (
          <div className="flex flex-col">
            {clients.map((c) => (
              <div key={c.clientId} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-divider py-3 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{c.name ?? t`No name`}</span>
                  <span className="font-mono text-xs text-subtle">
                    {shortId(c.clientId)} {t`· since`} {formatWhen(c.createdAt)}
                  </span>
                </div>
                <LastCall clientId={c.clientId} />
                <Pill tone={c.hasConsent ? 'ok' : 'muted'}>{c.hasConsent ? t`consent given` : t`no consent`}</Pill>
                <span className="w-24 font-mono text-xs text-muted-foreground">
                  {c.activeTokens} {c.activeTokens === 1 ? trc('one', 'active') : trc('many', 'active')}
                </span>
                <ConfirmButton action={revokeClientAction} fields={{ clientId: c.clientId }} label={t`Revoke`} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px]">{t`Active tokens`}</h2>
          <span className="text-xs text-subtle">{t`access — 1 hour, refresh — 30 days`}</span>
        </div>
        {tokens.length === 0 ? (
          <Empty text={t`No active tokens.`} />
        ) : (
          <div className="flex flex-col">
            {tokens.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-divider py-3 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span>
                    {item.clientName ?? t`Client`} · <span className="font-mono text-muted-foreground">rt_…{item.tokenTail}</span>
                  </span>
                  <span className="text-xs text-subtle">
                    {t`issued`} {formatWhen(item.createdAt)} {t`· refresh until`} {formatWhen(item.expiresAt)}
                  </span>
                </div>
                <ConfirmButton action={revokeTokenAction} fields={{ id: item.id }} label={t`Revoke`} />
              </div>
            ))}
            <div className="pt-2 text-xs text-subtle">
              {t`Revoking a token stops the refresh; the current access token lives up to an hour. To cut a client off at once, revoke it in the list above.`}
            </div>
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px]">{t`IP restriction for MCP`}</h2>
          <span className="text-xs text-subtle">{t`Empty — let everyone in. Claude (Anthropic) comes from 160.79.104.0/21, ChatGPT from OpenAI addresses. This is defense in depth, OAuth stays.`}</span>
        </div>
        <CidrForm initial={getAllowedCidrs()} trustProxy={env().TRUST_PROXY} />
      </Card>
    </>
  )
}

function LastCall({ clientId }: { clientId: string }) {
  const call = lastCallByClient(clientId)
  if (!call) return <span className="w-full text-xs text-subtle sm:w-auto">{t`no calls`}</span>
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
