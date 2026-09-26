import { and, desc, eq, gt } from 'drizzle-orm'
import { PageHeader } from '@/components/admin/page-header'
import { BackupCodesRow, PasswordRow, SessionsRow, SettingsRow } from '@/components/settings/account'
import { Card } from '@/components/ui/card'
import { StatusDot } from '@/components/ui/pill'
import { plural } from '@/lib/connectors/format'
import { getDb } from '@/lib/db'
import { account, session as sessionTable } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { formatAgo, formatWhen } from '@/lib/format'
import { JOURNAL_RETENTION_DAYS } from '@/lib/journal'
import { fingerprint, jwksStatus, secretsStatus } from '@/lib/keys'
import { requireAdmin } from '@/lib/session'
import { HUB_VERSION, hubBuild } from '@/lib/version'
import pkg from '@/package.json'

export const dynamic = 'force-dynamic'

function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'неизвестно'
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
  const secrets = secretsStatus()
  const keys = jwksStatus()

  return (
    <>
      <PageHeader title="Настройки" subtitle="Аккаунт, ключи и обслуживание хаба." />

      <div className="grid gap-3.5 lg:grid-cols-2">
        <Card className="flex flex-col p-4 md:p-5">
          <h2 className="pb-2 text-[15px]">Аккаунт</h2>
          <SettingsRow title="Email" detail={session.user.email} />
          <PasswordRow changedAgo={credential ? formatAgo(credential.updatedAt) : '—'} />
          <BackupCodesRow />
          <SessionsRow
            sessions={sessions.map((s) => ({ id: s.id, current: s.id === session.session.id, label: `${deviceLabel(s.userAgent)}${s.ipAddress ? `, ${s.ipAddress}` : ''}` }))}
          />
        </Card>

        <Card className="flex flex-col p-4 md:p-5">
          <h2 className="pb-2 text-[15px]">Ключи</h2>
          <KeyRow
            ok={secrets.unreadable === 0}
            title="Мастер-ключ шифрования"
            detail={
              <>
                из <span className="font-mono">HUB_MASTER_KEY</span> · отпечаток <span className="font-mono">{fingerprint(e.HUB_MASTER_KEY)}</span> · {secrets.total}{' '}
                {plural(secrets.total, ['секрет зашифрован', 'секрета зашифровано', 'секретов зашифровано'])}
                {secrets.unreadable > 0 && <span className="text-err"> · {secrets.unreadable} не расшифровываются — введи их заново</span>}
              </>
            }
          />
          <KeyRow ok title="Секрет сессий" detail={<>из <span className="font-mono">BETTER_AUTH_SECRET</span> · задан</>} />
          <KeyRow
            ok={keys.keys > 0}
            title="Ключи подписи токенов (JWKS)"
            detail={keys.keys ? `${keys.keys} ${plural(keys.keys, ['ключ', 'ключа', 'ключей'])} · создан ${formatWhen(keys.oldest)}` : 'появятся при первой выдаче токена Claude'}
          />
          <p className="pt-3 text-xs text-subtle">
            Ключи живут в <span className="font-mono">.env</span> на NAS и здесь не показываются. Потеря мастер-ключа — переввод паролей коннекторов, остальное цело.
          </p>
        </Card>

        <Card className="flex flex-col p-4 md:p-5">
          <h2 className="pb-2 text-[15px]">Общие</h2>
          <SettingsRow title="Публичный адрес" detail={<span className="font-mono">{e.BASE_URL}</span>} />
          <SettingsRow title="Прокси" detail={e.TRUST_PROXY ? 'TRUST_PROXY включён: IP берётся из X-Forwarded-For' : 'TRUST_PROXY выключен'} />
          <SettingsRow title="Журнал" detail={`хранится ${JOURNAL_RETENTION_DAYS} дней`} />
          <SettingsRow title="Часовой пояс" detail={Intl.DateTimeFormat().resolvedOptions().timeZone} />
          <p className="pt-3 text-xs text-subtle">Меняются в .env / docker-compose.yml на NAS и применяются после перезапуска контейнера.</p>
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
