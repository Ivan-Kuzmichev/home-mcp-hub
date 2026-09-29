import { PageHeader } from '@/components/admin/page-header'
import { Card } from '@/components/ui/card'
import { Pill } from '@/components/ui/pill'
import { approxTokens, inspectMcp, type InspectedTool } from '@/lib/mcp/inspect'
import { INSTRUCTIONS_HEAD } from '@/lib/mcp/server'

export const dynamic = 'force-dynamic'

/** What actually went in: the mode alone does not say whether there is an own text. */
function source(p: { mode: 'append' | 'replace'; standard: string | null; own: string | null }): string {
  if (p.mode === 'replace') return 'своя вместо стандартной'
  if (p.standard && p.own) return 'стандартная + своя'
  return p.own ? 'своя (стандартной нет)' : 'стандартная'
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="flex flex-col gap-1 p-3 md:p-4">
      <span className="text-xs text-subtle">{label}</span>
      <span className="font-heading text-lg font-semibold">{value}</span>
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </Card>
  )
}

/** Where a connector's part falls against the ChatGPT boundary. */
function Reach({ at, length }: { at: number; length: number }) {
  if (at < 0) return null
  if (at + length <= INSTRUCTIONS_HEAD) return <span className="text-ok"> · в первых {INSTRUCTIONS_HEAD}</span>
  if (at < INSTRUCTIONS_HEAD) return <span className="text-warn"> · обрезается на границе</span>
  return <span className="text-warn"> · за границей {INSTRUCTIONS_HEAD}</span>
}

function Hints({ tool }: { tool: InspectedTool }) {
  const a = tool.annotations ?? {}
  return (
    <span className="flex flex-wrap gap-1.5">
      {a.readOnlyHint === true && <Pill tone="muted">только чтение</Pill>}
      {a.destructiveHint === true && <Pill tone="warn">разрушающий</Pill>}
      {a.idempotentHint === true && <Pill tone="muted">идемпотентный</Pill>}
      {a.openWorldHint === true && <Pill tone="muted">внешний мир</Pill>}
    </span>
  )
}

export default async function DiagnosticsPage() {
  const snap = await inspectMcp()
  const toolsJson = JSON.stringify(snap.tools)
  const total = snap.instructions.length + toolsJson.length
  const head = snap.instructions.slice(0, INSTRUCTIONS_HEAD)
  const tail = snap.instructions.slice(INSTRUCTIONS_HEAD)
  const n = (x: number) => x.toLocaleString('ru-RU')
  return (
    <>
      <PageHeader
        title="Диагностика"
        subtitle="Что хаб отдаёт модели при подключении: инструкции сервера и список инструментов — ровно так, как их получает клиент."
      />

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3.5">
        <Stat label="Сервер" value={snap.serverInfo.title ?? snap.serverInfo.name} hint={`v${snap.serverInfo.version} · MCP ${snap.protocolVersion}`} />
        <Stat label="Инструменты" value={n(snap.tools.length)} hint={`${n(toolsJson.length)} символов`} />
        <Stat
          label="Инструкции"
          value={`${n(snap.instructions.length)} симв.`}
          hint={tail ? `${n(tail.length)} за границей ${INSTRUCTIONS_HEAD} для ChatGPT` : `целиком в ${INSTRUCTIONS_HEAD} символах · ≈ ${n(approxTokens(snap.instructions.length))} токенов`}
        />
        <Stat label="Всего в контексте" value={`≈ ${n(approxTokens(total))} ток.`} hint="грубая оценка, ~3 символа на токен" />
      </div>

      <Card className="flex flex-col gap-3 p-3.5 md:p-[18px]">
        <h2 className="text-sm md:text-[15px]">Инструкции сервера</h2>
        <span className="text-xs text-subtle">
          Клиент получает их при подключении, модель читает в начале каждого чата. Claude берёт текст целиком, ChatGPT надёжно — только первые {INSTRUCTIONS_HEAD}{' '}
          символов. {snap.custom ? 'Сейчас отдаётся своя инструкция из «Настроек» → «Свой initialize».' : 'Меняются в настройках коннекторов.'}
        </span>
        <pre className="overflow-x-auto rounded-md bg-secondary/60 px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
          {head}
          {tail && (
            <>
              <span className="my-1.5 block border-t border-dashed border-warn/60 pt-1 font-sans text-[11px] text-warn">
                граница {INSTRUCTIONS_HEAD} символов — дальше ChatGPT может не прочитать
              </span>
              <span className="text-subtle">{tail}</span>
            </>
          )}
        </pre>
        {snap.custom && (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-muted-foreground">
              Полные правила — отдаёт <span className="font-mono">hub_guide</span> · {n(snap.guide.length)} симв.
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-md bg-secondary/60 px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">{snap.guide}</pre>
          </details>
        )}
        {snap.parts.length > 0 && (
          <div className="flex flex-col">
            {snap.parts.map((p) => (
              <div key={p.connector} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-divider py-2 text-[13px] last:border-b-0">
                <span className="w-32 shrink-0 font-medium">{p.connector}</span>
                <span className="text-muted-foreground">
                  {p.text ? `${source(p)} · ${n(p.text.length)} симв.` : 'без инструкции'}
                  {p.text && (snap.custom ? <span className="text-subtle"> · в hub_guide</span> : <Reach at={snap.instructions.indexOf(p.text)} length={p.text.length} />)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-3.5 md:p-[18px]">
        <h2 className="text-sm md:text-[15px]">Инструменты</h2>
        <div className="flex flex-col">
          {snap.tools.map((t) => (
            <details key={t.name} className="group border-b border-divider py-2.5 last:border-b-0">
              <summary className="flex cursor-pointer list-none flex-col gap-1 md:flex-row md:items-center md:gap-3">
                <span className="font-mono text-[13px] md:w-52 md:shrink-0">{t.name}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{t.title ?? t.description}</span>
                <Hints tool={t} />
              </summary>
              <div className="mt-2.5 flex flex-col gap-2">
                {t.description && <p className="text-[13px] leading-5 whitespace-pre-wrap">{t.description}</p>}
                <pre className="overflow-x-auto rounded-md bg-secondary/60 px-3 py-2 font-mono text-[11px] leading-4 text-muted-foreground">
                  {JSON.stringify(t.inputSchema, null, 2)}
                </pre>
              </div>
            </details>
          ))}
        </div>
      </Card>
    </>
  )
}
