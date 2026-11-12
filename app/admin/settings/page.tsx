import { and, desc, eq, gt } from 'drizzle-orm'
import { PrefixForm } from '@/components/access/prefix-form'
import { PageHeader } from '@/components/admin/page-header'
import { BackupCodesRow, PasswordRow, SessionsRow, SettingsRow } from '@/components/settings/account'
import { InitializeForm } from '@/components/settings/initialize-form'
import { LanguageForm } from '@/components/settings/language-form'
import { Card } from '@/components/ui/card'
import { Pill } from '@/components/ui/pill'
import { StatusDot } from '@/components/ui/pill'
import { plural } from '@/lib/connectors/format'
import { getDb } from '@/lib/db'
import { account, session as sessionTable } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { formatAgo, formatWhen } from '@/lib/format'
import { JOURNAL_RETENTION_DAYS } from '@/lib/journal'
import { fingerprint, jwksStatus, secretsStatus } from '@/lib/keys'
import { defaultCustomInstructions, INSTRUCTIONS_HEAD } from '@/lib/mcp/server'
import { getLang, langFromEnv, t, tr } from '@/lib/i18n'
import { getPrefix } from '@/lib/prefix'
import { getCustomInstructions } from '@/lib/settings'
import { requireAdmin } from '@/lib/session'
import { HUB_VERSION, hubBuild } from '@/lib/version'
import pkg from '@/package.json'

export const dynamic = 'force-dynamic'

function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return t`unknown`
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''
  return [os, browser].filter(Boolean).join(' · ') || ua.slice(0, 30)
}

const version = (name: string) => (pkg.dependencies as Record<string, string>)[name]?.replace(/^[\^~]/, '') ?? '?'

export default async function SettingsPage() {
  const session = await requireAdmin()
  const e = env()
  // Straight from the table: better-auth's list-sessions demands a «fresh» session (< 1 day since
  // sign-in) and throws on the 7-day admin session.
  const sessions = getDb()
    .select({ id: sessionTable.id, userAgent: sessionTable.userAgent, ipAddress: sessionTable.ipAddress })
    .from(sessionTable)
    .where(and(eq(sessionTable.userId, session.user.id), gt(sessionTable.expiresAt, new Date())))
    .orderBy(desc(sessionTable.updatedAt))
    .all()
  const credential = getDb()
    .select({ updatedAt: account.updatedAt })
    .from(account)
    .where(and(eq(account.userId, session.user.id), eq(account.providerId, 'credential')))
    .get()
  const prefix = getPrefix()
  const host = new URL(e.BASE_URL).host
  const secrets = secretsStatus()
  const keys = jwksStatus()
  const custom = getCustomInstructions()

  return (
    <>
      <PageHeader title={t`Settings`} subtitle={t`Account, secret prefix, keys and hub maintenance.`} />

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px]">{tr('Language')}</h2>
          <span className="text-xs text-subtle">
            {tr(
              'The admin panel and pages switch at once, tool replies from the next call. Tool descriptions and the hub instructions reach the assistant at the start of a chat, so they change in a new chat.',
            )}
          </span>
        </div>
        <LanguageForm current={getLang()} fixedByEnv={langFromEnv() !== null} />
        <p className="text-xs text-warn">{tr('Scripts that read the text of hub.tool replies may break after a switch: the replies change language too.')}</p>
      </Card>

      <Card className="flex flex-col gap-4 p-4 md:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[15px]">{t`Secret prefix`}</h2>
          <Pill tone="muted">{t`on everything except /p/* and /f/*`}</Pill>
        </div>
        <PrefixForm current={prefix} host={host} />
        <dl className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-3 text-[13px]">
          <UrlRow label={t`Admin panel`} value={`${host}/${prefix}/admin`} />
          <UrlRow label={t`MCP endpoint`} value={`${host}/${prefix}/api/mcp`} />
          <UrlRow label={t`Prototypes and file links — without the prefix`} value={`${host}/p/…, ${host}/f/…`} />
          <div className="pt-1 text-xs text-subtle">{t`Everything else answers with an empty 404. The prefix hides the hub from scanners but does not replace OAuth and 2FA.`}</div>
        </dl>
      </Card>

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px]">{t`Custom initialize`}</h2>
          <span className="text-xs text-subtle">
            {t`The text an MCP client receives when it connects. ChatGPT reliably reads only the first`} {INSTRUCTIONS_HEAD} {t`characters, so you can send a short version with a pointer to`} <span className="font-mono">hub_guide</span>{t`. What is sent now is in Diagnostics.`}
          </span>
        </div>
        <InitializeForm enabled={custom.enabled} text={custom.text} template={defaultCustomInstructions()} head={INSTRUCTIONS_HEAD} />
      </Card>

      <div className="grid gap-3.5 lg:grid-cols-2">
        <Card className="flex flex-col p-4 md:p-5">
          <h2 className="pb-2 text-[15px]">{t`Account`}</h2>
          <SettingsRow title="Email" detail={session.user.email} />
          <PasswordRow changedAgo={credential ? formatAgo(credential.updatedAt) : '—'} />
          <BackupCodesRow />
          <SessionsRow
            sessions={sessions.map((s) => ({ id: s.id, current: s.id === session.session.id, label: `${deviceLabel(s.userAgent)}${s.ipAddress ? `, ${s.ipAddress}` : ''}` }))}
          />
        </Card>

        <Card className="flex flex-col p-4 md:p-5">
          <h2 className="pb-2 text-[15px]">{t`Keys`}</h2>
          <KeyRow
            ok={secrets.unreadable === 0}
            title={t`Encryption master key`}
            detail={
              <>
                {t`from`} <span className="font-mono">HUB_MASTER_KEY</span> {t`· fingerprint`} <span className="font-mono">{fingerprint(e.HUB_MASTER_KEY)}</span> · {secrets.total}{' '}
                {plural(secrets.total, ['secret encrypted', 'secrets encrypted'])}
                {secrets.unreadable > 0 && <span className="text-err"> · {secrets.unreadable} {t`cannot be decrypted — enter them again`}</span>}
              </>
            }
          />
          <KeyRow ok title={t`Session secret`} detail={<>{t`from`} <span className="font-mono">BETTER_AUTH_SECRET</span> {t`· set`}</>} />
          <KeyRow
            ok={keys.keys > 0}
            title={t`Token signing keys (JWKS)`}
            detail={keys.keys ? t`${keys.keys} ${plural(keys.keys, ['key', 'keys'])} · created ${formatWhen(keys.oldest)}` : t`they appear when the first token is issued to an MCP client`}
          />
          <p className="pt-3 text-xs text-subtle">
            {t`Keys live in`} <span className="font-mono">.env</span> {t`on the NAS and are not shown here. Losing the master key means re-entering connector passwords, everything else stays.`}
          </p>
        </Card>

        <Card className="flex flex-col p-4 md:p-5">
          <h2 className="pb-2 text-[15px]">{t`General`}</h2>
          <SettingsRow title={t`Public address`} detail={<span className="font-mono">{e.BASE_URL}</span>} />
          <SettingsRow title={t`Proxy`} detail={e.TRUST_PROXY ? t`TRUST_PROXY is on: the IP comes from X-Forwarded-For` : t`TRUST_PROXY is off`} />
          <SettingsRow title={t`Activity`} detail={t`kept for ${JOURNAL_RETENTION_DAYS} days`} />
          <SettingsRow title={t`Time zone`} detail={Intl.DateTimeFormat().resolvedOptions().timeZone} />
          <p className="pt-3 text-xs text-subtle">{t`Changed in .env / docker-compose.yml on the NAS and applied after a container restart.`}</p>
        </Card>

        <Card className="flex flex-col gap-1 p-4 md:p-5">
          <span className="font-medium">
            Home MCP Hub <span className="font-mono">v{HUB_VERSION}</span>
            {hubBuild() && <span className="font-mono text-subtle"> · {hubBuild()}</span>}
          </span>
          <span className="text-xs text-subtle">
            Next.js {version('next')} · better-auth {version('better-auth')} · MCP SDK {version('@modelcontextprotocol/server')} · Node {process.versions.node}
          </span>
        </Card>
      </div>
    </>
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

function KeyRow({ ok, title, detail }: { ok: boolean; title: string; detail: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-divider py-3 last:border-b-0">
      <StatusDot tone={ok ? 'ok' : 'err'} className="mt-1.5" />
      <div className="flex min-w-0 flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-subtle">{detail}</span>
      </div>
    </div>
  )
}
