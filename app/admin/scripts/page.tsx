import { t, tr } from '@/lib/i18n'
import { Lock } from 'lucide-react'
import { PageHeader } from '@/components/admin/page-header'
import { ReviewCard } from '@/components/scripts/review-card'
import { ScriptRow } from '@/components/scripts/script-row'
import { ConnectorSharing } from '@/components/scripts/connector-sharing'
import { SecretsForm } from '@/components/scripts/secrets-form'
import { CronForm } from '@/components/scripts/cron-form'
import { ToolForm } from '@/components/scripts/tool-form'
import { Card } from '@/components/ui/card'
import { formatAgo, formatWhen } from '@/lib/format'
import { activeConfig } from '@/lib/connectors/active'
import { describeConnectorSharing } from '@/lib/scripts/connector-secrets'
import { listSecrets } from '@/lib/scripts/secrets'
import { listRuns, listScripts, nextRun, STATUS_LABELS, statusOf, type Script } from '@/lib/scripts/store'
import { describeParams } from '@/lib/scripts/tool-spec'
import { requireAdmin } from '@/lib/session'

export const dynamic = 'force-dynamic'

const secretsIn = (code: string) => [...new Set([...code.matchAll(/\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g)].map((m) => m[1]!))]
const hostsIn = (code: string) => [...new Set([...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase()))]
const TONES = { pending: 'warn', rejected: 'err', approved: 'muted', active: 'ok' } as const

export default async function ScriptsPage() {
  // Pages render in parallel with the layout: each one checks the session itself.
  await requireAdmin()
  const all = listScripts()
  const pending = all.filter((s) => statusOf(s) === 'pending')
  const secrets = listSecrets()
  const crons = all.filter((s) => s.kind === 'cron')
  const tools = all.filter((s) => s.kind === 'tool')
  const localOff = (activeConfig('scripts') as { allowLocal?: boolean } | null)?.allowLocal !== true

  return (
    <>
      <PageHeader title={t`Scripts`} subtitle={t`Scheduled JS and your own MCP tools. The assistant writes the code, only what you approved runs.`} />

      {pending.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="px-1 text-[15px]">{t`Waiting for approval`}</h2>
          {pending.map((s) => (
            <ReviewCard
              key={`${s.id}-${s.codeHash}`}
              data={{
                id: s.id,
                name: s.name,
                description: s.description,
                schedule: s.schedule,
                tool: s.kind === 'tool' ? { params: describeParams(s.spec), readOnly: !!s.spec?.readOnly, previousParams: s.approvedHash ? describeParams(s.approvedSpec) : null } : null,
                code: s.code,
                codeHash: s.codeHash,
                previousCode: s.approvedCode,
                secretsUsed: secretsIn(s.code),
                hosts: hostsIn(s.code),
                updatedAgo: formatAgo(s.updatedAt),
              }}
            />
          ))}
        </div>
      )}

      <Card className="flex flex-col p-4 md:p-5">
        <h2 className="pb-1 text-[15px]">{t`Cron scripts`}</h2>
        {crons.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-subtle">{t`No scripts. Ask the assistant: “set up a cron that sends the finished downloads to Telegram every morning”, or add one yourself below.`}</div>
        ) : (
          crons.map((s) => <ScriptRow key={`${s.id}-${s.updatedAt.getTime()}`} s={rowOf(s)} />)
        )}
        <CronForm />
      </Card>

      <Card className="flex flex-col p-4 md:p-5">
        <div className="flex flex-col gap-0.5 pb-1">
          <h2 className="text-[15px]">{t`MCP tools`}</h2>
          <span className="text-xs text-subtle">
            {t`Your own tools the assistant calls itself: code with parameters, the same secrets and network as scripts. A new tool reaches the assistant in a new chat.`}
          </span>
        </div>
        {tools.length === 0 ? (
          <div className="py-4 text-[13px] text-subtle">{t`No tools. Ask the assistant: “make a tool that returns the weather for a city”, or add one yourself below.`}</div>
        ) : (
          tools.map((s) => <ScriptRow key={`${s.id}-${s.updatedAt.getTime()}`} s={rowOf(s)} />)
        )}
        <ToolForm />
      </Card>

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px]">{t`Secrets`}</h2>
          <span className="text-xs text-subtle">{t`Tokens and keys for scripts. Encrypted with the master key, not shown after saving.`}</span>
        </div>
        <SecretsForm secrets={secrets.map((s) => ({ name: s.name, hosts: s.hosts, description: s.description, updated: formatAgo(s.updatedAt) }))} />
      </Card>

      <Card className="flex flex-col gap-2 p-4 md:p-5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px]">{t`Connector settings`}</h2>
          <span className="text-xs text-subtle">
            {t`Open a connector's address, keys and parameters to scripts. In code it is the same`} <span className="font-mono">{t`{{secret:NAME}}`}</span>{t` form; values are taken from the connector on every run. Keys and passwords (`}<Lock size={11} className="inline" />{t`) are substituted only into requests to the connector address, everything else is a plain value.`}
          </span>
        </div>
        <ConnectorSharing items={describeConnectorSharing()} localOff={localOff} />
      </Card>
    </>
  )
}

function rowOf(s: Script) {
  const status = statusOf(s)
  const next = status === 'active' && s.kind === 'cron' ? nextRun(s.schedule) : null
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    schedule: s.schedule,
    tool: s.kind === 'tool' ? { params: describeParams(s.spec), readOnly: !!s.spec?.readOnly } : null,
    status,
    statusLabel: tr(STATUS_LABELS[status]),
    tone: TONES[status],
    approved: s.approvedHash === s.codeHash,
    enabled: s.enabled,
    next: next ? formatWhen(next) : null,
    last: s.lastRunAt ? `${formatAgo(s.lastRunAt)} — ${s.lastRunOk ? t`ok` : t`error`}` : null,
    rejectReason: status === 'rejected' ? s.rejectReason : null,
    code: s.code,
    runs: listRuns(s.id, 10).map((r) => ({
      id: r.id,
      when: formatWhen(r.startedAt),
      trigger: r.trigger,
      ok: r.ok,
      duration: t`${(r.durationMs / 1000).toFixed(1)} s`,
      error: r.error,
      output: r.output,
      logs: r.logs,
    })),
  }
}
