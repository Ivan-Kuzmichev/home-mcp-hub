import cron, { type ScheduledTask } from 'node-cron'
import { logToolCall } from '../journal'
import { logger } from '../logger'
import { DEFAULT_NET_POLICY, type NetPolicy } from './net'
import { runScript, type RunResult } from './sandbox'
import { SecretVault } from './secrets'
import { limitsFor, type LimitSettings } from './limits'
import { getScript, listScripts, recordRun, statusOf, type Script } from './store'
import { t } from '../i18n'

/**
 * Hub tools for hub.tool(); imported lazily to avoid a cycle with the registry. Read-only tools
 * always; tools that change data only while scripts may reach the local network — the same
 * services are reachable over fetch then anyway. The scripts connector's own tools are never
 * available: a script must not write or approve scripts.
 */
async function callHubTool(name: string, args: unknown, allowWrite: boolean): Promise<string> {
  const { connectorStates, activeConfig, enabledTools } = await import('../connectors/active')
  const { resolveResult } = await import('../connectors/resolve')
  const { outputText } = await import('../connectors/types')
  for (const state of connectorStates()) {
    if (state.status !== 'active') continue
    const tool = enabledTools(state).find((t) => t.name === name)
    if (!tool) continue
    if (state.connector.id === 'scripts') throw new Error(t`${name} is not available to scripts`)
    if (!tool.annotations.readOnlyHint && !allowWrite) throw new Error(t`${name} changes data — scripts may do that only when the local network is open in the script settings`)
    const jackett = activeConfig('jackett') as { baseUrl?: string; apiKey?: string } | null
    const access = jackett?.baseUrl && jackett.apiKey ? { baseUrl: jackett.baseUrl, apiKey: jackett.apiKey } : null
    return outputText(await tool.run(args, { config: state.config, resolveResult: (id) => resolveResult(id, access) }))
  }
  throw new Error(t`There is no ${name} tool or its connector is off`)
}

/** Everything a run needs from the hub: network policy and limits, secrets with shared connector values, hub tools. */
async function runDeps(kind: 'cron' | 'tool') {
  const c = await scriptsConfig()
  const net = netPolicy(c)
  const { connectorValues } = await import('./connector-secrets')
  return { net, limits: limitsFor(kind, c), vault: new SecretVault(connectorValues()), callTool: (name: string, args: unknown) => callHubTool(name, args, net.local) }
}

type ScriptsConfig = LimitSettings & { allowLocal?: boolean; allowExternal?: boolean }

async function scriptsConfig(): Promise<ScriptsConfig | null> {
  const { activeConfig } = await import('../connectors/active')
  return activeConfig('scripts') as ScriptsConfig | null
}

/** Network switches from the scripts connector; external only if it cannot be read. */
function netPolicy(c: ScriptsConfig | null): NetPolicy {
  return c ? { local: c.allowLocal === true, external: c.allowExternal !== false } : DEFAULT_NET_POLICY
}

const globalForSched = globalThis as unknown as { __hubScriptTasks?: Map<string, { task: ScheduledTask; schedule: string }>; __hubScriptBusy?: Set<string> }
const tasks = (globalForSched.__hubScriptTasks ??= new Map())
const busy = (globalForSched.__hubScriptBusy ??= new Set())

/** Run a script now. Refuses code that is not the approved version. */
export async function executeScript(id: string, trigger: 'cron' | 'manual' | 'assistant'): Promise<RunResult> {
  const s = getScript(id)
  if (!s) throw new Error(t`Script not found`)
  if (s.approvedHash !== s.codeHash) throw new Error(t`The code is not approved — it cannot run`)
  if (busy.has(id)) throw new Error(t`The script is already running`)
  busy.add(id)
  try {
    const r = await runScript(s.id, s.code, await runDeps('cron'))
    recordRun(s, trigger, r)
    logToolCall({
      tool: `cron:${s.name}`,
      connectorId: 'scripts',
      args: { trigger },
      ok: r.ok,
      result: r.ok ? (r.output ?? t`finished`) : undefined,
      error: r.error ?? undefined,
      durationMs: r.durationMs,
    })
    return r
  } finally {
    busy.delete(id)
  }
}

/**
 * Call an approved MCP tool. The journal entry is written by the MCP layer, like for every
 * tool; the run history is kept here.
 */
export async function executeTool(id: string, args: Record<string, unknown>, trigger: 'assistant' | 'manual' = 'assistant'): Promise<RunResult> {
  const s = getScript(id)
  if (!s || s.kind !== 'tool') throw new Error(t`Tool not found`)
  if (s.approvedHash !== s.codeHash) throw new Error(t`The code is not approved — it cannot be called`)
  const r = await runScript(s.id, s.code, { ...(await runDeps('tool')), args })
  recordRun(s, trigger, r)
  return r
}

/** Align node-cron tasks with active scripts. Called at start and after every change. */
export function syncSchedules(): void {
  const active = new Map(listScripts().filter((s) => s.kind === 'cron' && statusOf(s) === 'active').map((s) => [s.id, s] as [string, Script]))
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
