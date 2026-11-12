import { localeTag, t } from '@/lib/i18n'
import { PageHeader } from '@/components/admin/page-header'
import { Card } from '@/components/ui/card'
import { Pill } from '@/components/ui/pill'
import { approxTokens, inspectMcp, type InspectedTool } from '@/lib/mcp/inspect'
import { INSTRUCTIONS_HEAD } from '@/lib/mcp/server'
import { requireAdmin } from '@/lib/session'

export const dynamic = 'force-dynamic'

/** What actually went in: the mode alone does not say whether there is an own text. */
function source(p: { mode: 'append' | 'replace'; standard: string | null; own: string | null }): string {
  if (p.mode === 'replace') return t`custom instead of the standard`
  if (p.standard && p.own) return t`standard + custom`
  return p.own ? t`custom (no standard)` : t`standard`
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
  if (at + length <= INSTRUCTIONS_HEAD) return <span className="text-ok"> {t`· within the first`} {INSTRUCTIONS_HEAD}</span>
  if (at < INSTRUCTIONS_HEAD) return <span className="text-warn"> {t`· cut at the limit`}</span>
  return <span className="text-warn"> {t`· past the limit`} {INSTRUCTIONS_HEAD}</span>
}

function Hints({ tool }: { tool: InspectedTool }) {
  const a = tool.annotations ?? {}
  return (
    <span className="flex flex-wrap gap-1.5">
      {a.readOnlyHint === true && <Pill tone="muted">{t`read only`}</Pill>}
      {a.destructiveHint === true && <Pill tone="warn">{t`destructive`}</Pill>}
      {a.idempotentHint === true && <Pill tone="muted">{t`idempotent`}</Pill>}
      {a.openWorldHint === true && <Pill tone="muted">{t`open world`}</Pill>}
    </span>
  )
}

export default async function DiagnosticsPage() {
  // Pages render in parallel with the layout: each one checks the session itself.
  await requireAdmin()
  const snap = await inspectMcp()
  const toolsJson = JSON.stringify(snap.tools)
  const total = snap.instructions.length + toolsJson.length
  const head = snap.instructions.slice(0, INSTRUCTIONS_HEAD)
  const tail = snap.instructions.slice(INSTRUCTIONS_HEAD)
  const n = (x: number) => x.toLocaleString(localeTag())
  return (
    <>
      <PageHeader
        title={t`Diagnostics`}
        subtitle={t`What the hub gives the model on connection: the server instructions and the tool list — exactly as the client receives them.`}
      />

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3.5">
        <Stat label={t`Server`} value={snap.serverInfo.title ?? snap.serverInfo.name} hint={`v${snap.serverInfo.version} · MCP ${snap.protocolVersion}`} />
        <Stat label={t`Tools`} value={n(snap.tools.length)} hint={t`${n(toolsJson.length)} characters`} />
        <Stat
          label={t`Instructions`}
          value={t`${n(snap.instructions.length)} chars`}
          hint={tail ? t`${n(tail.length)} past the ${INSTRUCTIONS_HEAD} limit for ChatGPT` : t`whole within ${INSTRUCTIONS_HEAD} characters · ≈ ${n(approxTokens(snap.instructions.length))} tokens`}
        />
        <Stat label={t`Total in context`} value={t`≈ ${n(approxTokens(total))} tok.`} hint={t`a rough estimate, ~3 characters per token`} />
      </div>

      <Card className="flex flex-col gap-3 p-3.5 md:p-[18px]">
        <h2 className="text-sm md:text-[15px]">{t`Server instructions`}</h2>
        <span className="text-xs text-subtle">
          {t`The client receives them on connection, the model reads them at the start of every chat. Claude takes the whole text, ChatGPT reliably only the first`} {INSTRUCTIONS_HEAD}{' '}
          {t`characters.`} {snap.custom ? t`The custom text from Settings → Custom initialize is sent now.` : t`Changed in the connector settings.`}
        </span>
        <pre className="overflow-x-auto rounded-md bg-secondary/60 px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
          {head}
          {tail && (
            <>
              <span className="my-1.5 block border-t border-dashed border-warn/60 pt-1 font-sans text-[11px] text-warn">
                {t`limit`} {INSTRUCTIONS_HEAD} {t`characters — ChatGPT may not read further`}
              </span>
              <span className="text-subtle">{tail}</span>
            </>
          )}
        </pre>
        {snap.custom && (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-muted-foreground">
              {t`The full rules are given by`} <span className="font-mono">hub_guide</span> · {n(snap.guide.length)} {t`chars`}
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
                  {p.text ? t`${source(p)} · ${n(p.text.length)} chars` : t`no instructions`}
                  {p.text && (snap.custom ? <span className="text-subtle"> {t`· in hub_guide`}</span> : <Reach at={snap.instructions.indexOf(p.text)} length={p.text.length} />)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-3.5 md:p-[18px]">
        <h2 className="text-sm md:text-[15px]">{t`Tools`}</h2>
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
