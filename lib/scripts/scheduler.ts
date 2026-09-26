import cron, { type ScheduledTask } from 'node-cron'
import { logToolCall } from '../journal'
import { logger } from '../logger'
import { runScript, type RunResult } from './sandbox'
import { getScript, listScripts, recordRun, statusOf, type Script } from './store'

/** Read-only hub tools for hub.tool(); imported lazily to avoid a cycle with the registry. */
async function callReadOnlyTool(name: string, args: unknown): Promise<string> {
  const { connectorStates } = await import('../connectors/active')
  const { activeConfig } = await import('../connectors/active')
  const { resolveResult } = await import('../connectors/resolve')
  const { outputText } = await import('../connectors/types')
  for (const state of connectorStates()) {
    if (state.status !== 'active') continue
    const tool = state.connector.tools.find((t) => t.name === name)
    if (!tool || state.row.disabledTools.includes(name)) continue
    if (!tool.annotations.readOnlyHint) throw new Error(`${name} меняет данные — из скриптов доступны только инструменты для чтения`)
    const jackett = activeConfig('jackett') as { baseUrl?: string; apiKey?: string } | null
    const access = jackett?.baseUrl && jackett.apiKey ? { baseUrl: jackett.baseUrl, apiKey: jackett.apiKey } : null
    return outputText(await tool.run(args, { config: state.config, resolveResult: (id) => resolveResult(id, access) }))
  }
  throw new Error(`Инструмента ${name} нет или его коннектор выключен`)
}

const globalForSched = globalThis as unknown as { __hubScriptTasks?: Map<string, { task: ScheduledTask; schedule: string }>; __hubScriptBusy?: Set<string> }
const tasks = (globalForSched.__hubScriptTasks ??= new Map())
const busy = (globalForSched.__hubScriptBusy ??= new Set())

/** Run a script now. Refuses code that is not the approved version. */
export async function executeScript(id: string, trigger: 'cron' | 'manual' | 'assistant'): Promise<RunResult> {
  const s = getScript(id)
  if (!s) throw new Error('Скрипт не найден')
  if (s.approvedHash !== s.codeHash) throw new Error('Код не одобрен — запуск невозможен')
  if (busy.has(id)) throw new Error('Скрипт уже выполняется')
  busy.add(id)
  try {
    const r = await runScript(s.id, s.code, { callTool: callReadOnlyTool })
    recordRun(s, trigger, r)
    logToolCall({
      tool: `cron:${s.name}`,
      connectorId: 'scripts',
      args: { trigger },
      ok: r.ok,
      result: r.ok ? (r.output ?? 'готово') : undefined,
      error: r.error ?? undefined,
      durationMs: r.durationMs,
    })
    return r
  } finally {
    busy.delete(id)
  }
}

/** Align node-cron tasks with active scripts. Called at start and after every change. */
export function syncSchedules(): void {
  const active = new Map(listScripts().filter((s) => statusOf(s) === 'active').map((s) => [s.id, s] as [string, Script]))
  for (const [id, entry] of tasks) {
    const s = active.get(id)
    if (!s || s.schedule !== entry.schedule) {
      void entry.task.destroy()
      tasks.delete(id)
    }
  }
  for (const [id, s] of active) {
    if (tasks.has(id)) continue
    const task = cron.schedule(
      s.schedule,
      async () => {
        try {
          await executeScript(id, 'cron')
        } catch (e) {
          logger.warn({ script: id, err: e instanceof Error ? e.message : String(e) }, 'script run skipped')
        }
      },
      { name: `script:${id}`, noOverlap: true },
    )
    tasks.set(id, { task, schedule: s.schedule })
  }
}

export function scheduledCount(): number {
  return tasks.size
}
