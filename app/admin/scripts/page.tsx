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

export const dynamic = 'force-dynamic'

const secretsIn = (code: string) => [...new Set([...code.matchAll(/\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g)].map((m) => m[1]!))]
const hostsIn = (code: string) => [...new Set([...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase()))]
const TONES = { pending: 'warn', rejected: 'err', approved: 'muted', active: 'ok' } as const

export default function ScriptsPage() {
  const all = listScripts()
  const pending = all.filter((s) => statusOf(s) === 'pending')
  const secrets = listSecrets()
  const crons = all.filter((s) => s.kind === 'cron')
  const tools = all.filter((s) => s.kind === 'tool')
  const localOff = (activeConfig('scripts') as { allowLocal?: boolean } | null)?.allowLocal !== true

  return (
    <>
      <PageHeader title="Скрипты" subtitle="JS по расписанию и свои MCP-инструменты. Код пишет ассистент, запускается только одобренный тобой." />

      {pending.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="px-1 text-[15px]">Ждут одобрения</h2>
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
        <h2 className="pb-1 text-[15px]">Cron-скрипты</h2>
        {crons.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-subtle">Скриптов нет. Попроси ассистента: «заведи cron, который каждое утро присылает в Telegram список докачанного», или добавь сам ниже.</div>
        ) : (
          crons.map((s) => <ScriptRow key={`${s.id}-${s.updatedAt.getTime()}`} s={rowOf(s)} />)
        )}
        <CronForm />
      </Card>

      <Card className="flex flex-col p-4 md:p-5">
        <div className="flex flex-col gap-0.5 pb-1">
          <h2 className="text-[15px]">MCP-инструменты</h2>
          <span className="text-xs text-subtle">
            Свои инструменты, которые ассистент вызывает сам: код с параметрами, те же секреты и сеть, что у скриптов. Новый инструмент появляется у ассистента в новом чате.
          </span>
        </div>
        {tools.length === 0 ? (
          <div className="py-4 text-[13px] text-subtle">Инструментов нет. Попроси ассистента: «сделай инструмент, который по городу возвращает погоду», или добавь сам ниже.</div>
        ) : (
          tools.map((s) => <ScriptRow key={`${s.id}-${s.updatedAt.getTime()}`} s={rowOf(s)} />)
        )}
        <ToolForm />
      </Card>

      <Card className="flex flex-col gap-3 p-4 md:p-5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px]">Секреты</h2>
          <span className="text-xs text-subtle">Токены и ключи для скриптов. Шифруются мастер-ключом, после сохранения не показываются.</span>
        </div>
        <SecretsForm secrets={secrets.map((s) => ({ name: s.name, hosts: s.hosts, description: s.description, updated: formatAgo(s.updatedAt) }))} />
      </Card>

      <Card className="flex flex-col gap-2 p-4 md:p-5">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px]">Настройки коннекторов</h2>
          <span className="text-xs text-subtle">
            Открыть скриптам адрес, ключи и параметры коннектора. В коде — та же запись <span className="font-mono">{'{{secret:ИМЯ}}'}</span>; значения берутся из
            коннектора при каждом запуске. Ключи и пароли (<Lock size={11} className="inline" />) подставляются только в запросы на адрес коннектора, остальное — обычные значения.
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
    statusLabel: STATUS_LABELS[status],
    tone: TONES[status],
    approved: s.approvedHash === s.codeHash,
    enabled: s.enabled,
    next: next ? formatWhen(next) : null,
    last: s.lastRunAt ? `${formatAgo(s.lastRunAt)} — ${s.lastRunOk ? 'ок' : 'ошибка'}` : null,
    rejectReason: status === 'rejected' ? s.rejectReason : null,
    code: s.code,
    runs: listRuns(s.id, 10).map((r) => ({
      id: r.id,
      when: formatWhen(r.startedAt),
      trigger: r.trigger,
      ok: r.ok,
      duration: `${(r.durationMs / 1000).toFixed(1)} с`,
      error: r.error,
      output: r.output,
      logs: r.logs,
    })),
  }
}
