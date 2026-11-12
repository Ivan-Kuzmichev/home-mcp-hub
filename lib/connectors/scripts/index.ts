import { z } from 'zod'
import { registerCatalog, t, tr } from '../../i18n'
import { translateText } from '../../i18n/core'
import { formatAgo, formatWhen } from '../../format'
import { logger } from '../../logger'
import { executeScript, executeTool, syncSchedules } from '../../scripts/scheduler'
import { BOUNDS, DEFAULT_LIMITS, DEFAULT_TOOL_TIME_MS, limitsLine } from '../../scripts/limits'
import { SANDBOX_API_DOC } from '../../scripts/sandbox'
import { listSecrets } from '../../scripts/secrets'
import { describeParams, inputSchemaOf, MAX_PARAMS, paramInput } from '../../scripts/tool-spec'
import {
  approveScript,
  createScript,
  createTool,
  deleteScript,
  findScript,
  listRuns,
  listScripts,
  nextRun,
  ScriptError,
  setScriptEnabled,
  STATUS_LABELS,
  statusOf,
  updateScript,
  type Script,
} from '../../scripts/store'
import { plural, truncate } from '../format'
import { defineConnector, field, toolFor, ToolError } from '../types'

function limitField(key: keyof typeof BOUNDS, def: number, meta: { label: string; help?: string }) {
  const { min, max } = BOUNDS[key]
  // The help text is composed here, so its Russian is composed here too, from the catalog.
  const help = `${meta.help ? `${meta.help}. ` : ''}${min}–${max}, default ${def}`
  registerCatalog({ [help]: `${meta.help ? `${translateText('ru', meta.help)}. ` : ''}${min}–${max}, по умолчанию ${def}` })
  return field(z.coerce.number().int().min(min, { error: () => t`At least ${min}` }).max(max, { error: () => t`At most ${max}` }).default(def), {
    ...meta,
    help,
    widget: 'number',
    section: 'defaults',
  })
}

const configSchema = z.object({
  autoApprove: field(z.boolean().default(false), {
    label: 'No approval',
    help: 'Code from the assistant — cron scripts and MCP tools — is approved and turned on at once, without a review in the admin panel. You will not see it in advance',
    widget: 'switch',
  }),
  allowExternal: field(z.boolean().default(true), {
    label: 'Access to external addresses',
    help: 'fetch to sites and APIs on the internet (Telegram, weather and so on)',
    widget: 'switch',
  }),
  allowLocal: field(z.boolean().default(false), {
    label: 'Access to the local network',
    help: 'fetch to the NAS, containers, the router and localhost, plus hub tools that write through hub.tool (torrent_add, paperless_update…). A script will be able to change data in home services',
    widget: 'switch',
  }),
  cronTimeSec: limitField('cronTimeSec', DEFAULT_LIMITS.timeMs / 1000, { label: 'Cron script time, s', help: 'A whole run on schedule or by hand' }),
  toolTimeSec: limitField('toolTimeSec', DEFAULT_TOOL_TIME_MS / 1000, {
    label: 'Own tool time, s',
    help: 'A my_* call from a chat. The assistant waits for the answer, and the client may cut a call that is too long — more than a minute is risky',
  }),
  fetchTimeoutSec: limitField('fetchTimeoutSec', DEFAULT_LIMITS.fetchTimeoutMs / 1000, { label: 'One fetch, s', help: 'But no longer than what is left of the run time' }),
  maxFetches: limitField('maxFetches', DEFAULT_LIMITS.fetches, { label: 'Requests per run' }),
  maxResponseMb: limitField('maxResponseMb', DEFAULT_LIMITS.responseBytes / 1024 / 1024, { label: 'One response, MB', help: 'The sandbox has 64 MB of memory: a big response may not fit' }),
})
type Config = z.output<typeof configSchema>
const tool = toolFor<Config>()

const APPROVAL =
  'The code waits for the user\'s approval in the hub admin panel → Scripts; after approval the script turns on by itself. If the user rejects it, a new script is deleted and a change rolls back to the previous version.'

/** «Без одобрения»: the assistant's code is approved (and so enabled) as soon as it is saved. */
function autoApprove(config: Config, s: Script): Script {
  if (!config.autoApprove || s.approvedHash === s.codeHash) return s
  approveScript(s.id, s.codeHash)
  logger.info({ script: s.id }, 'script auto-approved')
  syncSchedules()
  return findScript(s.id)
}

function networkLine(c: Config): string {
  const hub = c.allowLocal ? t` hub.tool — any hub tools, including writing ones.` : t` hub.tool — read-only tools only.`
  if (c.allowExternal && c.allowLocal) return t`fetch may reach both external addresses and the local network.${hub}`
  if (c.allowLocal) return t`fetch may reach only the local network (NAS, containers, localhost); the internet is closed.${hub}`
  if (c.allowExternal) return t`fetch may reach only external addresses; the local network is closed.${hub}`
  return t`Network access for scripts is off: fetch does not work, only hub.tool and state are available.${hub}`
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ScriptError) throw new ToolError(e.message)
    throw e
  }
}

function line(s: Script): string {
  const status = statusOf(s)
  if (s.kind === 'tool') {
    const parts = [
      `${s.name} (${s.id})`,
      t`MCP tool`,
      describeParams(s.spec),
      s.spec?.readOnly ? t`read only` : t`changes data`,
      status === 'active' ? t`available` : tr(STATUS_LABELS[status]),
      s.lastRunAt ? t`last call ${formatAgo(s.lastRunAt)} — ${s.lastRunOk ? t`ok` : t`error`}` : null,
    ].filter(Boolean)
    return `• ${parts.join(' · ')}`
  }
  const next = status === 'active' ? nextRun(s.schedule) : null
  const parts = [
    `«${s.name}» (${s.id})`,
    `\`${s.schedule}\``,
    tr(STATUS_LABELS[status]),
    next ? t`next run ${formatWhen(next)}` : null,
    s.lastRunAt ? t`last ${formatAgo(s.lastRunAt)} — ${s.lastRunOk ? t`ok` : t`error`}` : null,
  ].filter(Boolean)
  return `• ${parts.join(' · ')}`
}

const refInput = z.string().min(1).describe('Id (sc_…) or the name of a script / tool from cron_list')

const TOOL_APPROVAL =
  'The tool waits for the user\'s approval in the hub admin panel → Scripts. After approval it appears in a new chat (the tool list does not update in the current one); test it now with cron_run and args.'

const paramsInput = z
  .array(paramInput)
  .max(MAX_PARAMS)
  .describe('Parameters: name (Latin, snake_case), type (string | number | boolean | enum), description, required (true by default), options — for enum')

export const scripts = defineConnector<Config>({
  id: 'scripts',
  name: 'Scripts',
  description: 'Scheduled JS scripts and your own MCP tools, the user approves the code',
  builtin: true,
  configSchema,

  instructions(c, { tools }) {
    const writes = ['cron_create', 'cron_update'].filter((t) => tools.includes(t))
    if (!tools.some((t) => t.startsWith('cron_'))) return null
    if (writes.length === 0) return t`Cron scripts: existing ones can be viewed and run; code cannot be created or changed. ${networkLine(c)}`
    const verb = writes.length > 1 ? t`send` : t`sends`
    return [
      c.autoApprove
        ? t`Cron scripts: ${writes.join('/')} turn the script on at once — there is no approval, so show the user the code and schedule before saving.`
        : t`Cron scripts: ${writes.join('/')} ${verb} the code to the user for approval; an approved script turns on by itself, only approved code can run.`,
      networkLine(c),
      tools.includes('tool_create')
        ? t`Own MCP tools: tool_create/tool_update — JS with parameters that you then call yourself (the name gets the my_ prefix); after ${c.autoApprove ? t`saving` : t`approval`} it appears in a new chat, in the current one test it with cron_run and args.`
        : null,
      tools.includes('script_secrets') ? t`Secrets — only as {{secret:NAME}} placeholders (the list — script_secrets), their values are not available to you.` : t`Secrets — only as {{secret:NAME}} placeholders, their values are not available to you.`,
      limitsLine(c),
    ]
      .filter(Boolean)
      .join(' ')
  },

  async test(c) {
    const list = listScripts()
    const active = list.filter((s) => statusOf(s) === 'active').length
    const pending = list.filter((s) => statusOf(s) === 'pending').length
    return {
      ok: true,
      summary: `${list.length} ${plural(list.length, ['script', 'scripts'])}`,
      details: [t`${active} enabled`, pending ? t`${pending} waiting for approval` : null, c.autoApprove ? t`no approval` : null].filter((d): d is string => !!d),
    }
  },

  tools: [
    tool({
      name: 'cron_list',
      title: 'Scripts and tools',
      description: 'The script list: schedule, status (waiting for approval / approved / enabled), next and last run.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run() {
        const list = listScripts()
        if (list.length === 0) return t`No scripts yet. Create one with cron_create.`
        return [`${list.length} ${plural(list.length, ['script', 'scripts'])}:`, ...list.map(line)].join('\n')
      },
    }),

    tool({
      name: 'cron_get',
      title: 'Script',
      description: 'A script\'s code, schedule, status and latest runs.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ script: refInput }),
      async run({ script }) {
        const s = await guard(() => findScript(script))
        const status = statusOf(s)
        return [
          line(s),
          s.description ? t`Description: ${s.description}` : null,
          s.kind === 'tool' && s.spec?.params.length ? t`Parameters:
${s.spec.params.map((p) => `  ${p.name}${p.required ? '' : '?'} (${p.type === 'enum' ? (p.options ?? []).join('|') : p.type})${p.description ? ` — ${p.description}` : ''}`).join('\n')}` : null,
          status === 'rejected' && s.rejectReason ? t`Rejection reason: ${s.rejectReason}` : null,
          status === 'pending' ? (s.kind === 'tool' ? tr(TOOL_APPROVAL) : tr(APPROVAL)) : null,
          t`Code:
\`\`\`js
${s.code}
\`\`\``,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'cron_create',
      title: 'Create cron script',
      description: `Create a JS script the hub runs on a cron schedule. Usually the code waits for the user's approval in the admin panel and turns on by itself after it; if approval is off in the hub, it turns on at once (the reply says which).\n${SANDBOX_API_DOC}`,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(500).optional().describe('What the script does — the user sees it when approving'),
        schedule: z.string().describe('A 5-field cron: “*/15 * * * *”, “0 9 * * *” (hub time)'),
        code: z.string().min(1),
      }),
      async run(args, { config }) {
        const s = autoApprove(config, await guard(() => createScript(args)))
        const next = statusOf(s) === 'active' ? nextRun(s.schedule) : null
        return [
          t`Created “${s.name}” (${s.id}), schedule \`${s.schedule}\`.`,
          statusOf(s) === 'active' ? t`Enabled without approval${next ? t`, next run ${formatWhen(next)}` : ''}. Test it with cron_run.` : tr(APPROVAL),
        ].join('\n')
      },
    }),

    tool({
      name: 'cron_update',
      title: 'Change cron script',
      description: 'Change the name, description, schedule or code. New code waits for approval again and the script is off until then (unless approval is off in the hub); a schedule change needs no approval.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        script: refInput,
        name: z.string().min(1).max(80).optional(),
        description: z.string().max(500).optional(),
        schedule: z.string().optional(),
        code: z.string().min(1).optional(),
      }),
      async run({ script, ...change }, { config }) {
        const before = await guard(() => findScript(script))
        if (before.kind === 'tool') throw new ToolError(t`${before.name} is an MCP tool, change it with tool_update`)
        const updated = await guard(() => updateScript(before, change))
        // Only new code is auto-approved: a script the admin switched off stays off.
        const s = updated.codeHash !== before.codeHash ? autoApprove(config, updated) : updated
        syncSchedules()
        const codeChanged = s.codeHash !== before.codeHash
        return [t`Updated “${s.name}”: ${tr(STATUS_LABELS[statusOf(s)])}.`, codeChanged && statusOf(s) === 'pending' ? t`The new code is off until approval. ${tr(APPROVAL)}` : null].filter(Boolean).join('\n')
      },
    }),

    tool({
      name: 'tool_create',
      title: 'Create MCP tool',
      description: `Create your own MCP tool: JS code with parameters that you then call yourself like any other tool (for example “exchange rate”, “movie rating via an API with the user's key”). The name gets the my_ prefix. The description is what you see in the tool list: when to call it and what it returns. The code sees the arguments in args, the result goes through return (text or an object, up to 10 KB), the time limit is in the hub instructions. Usually it waits for the user's approval; after that it is available in a new chat.\n${SANDBOX_API_DOC}`,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        name: z.string().min(1).max(40).describe('Name, for example eth_price → my_eth_price'),
        description: z.string().min(1).max(1000).describe('For the model: what it does, when to call it, what it returns'),
        params: paramsInput.default([]),
        read_only: z.boolean().default(true).describe('true — only reads; false — changes data somewhere (sends messages, writes to services)'),
        code: z.string().min(1),
      }),
      async run({ read_only, ...args }, { config }) {
        const s = autoApprove(config, await guard(() => createTool({ ...args, readOnly: read_only })))
        return [
          t`Created ${s.name} (${s.id}): ${describeParams(s.spec)}.`,
          statusOf(s) === 'active' ? t`Available without approval — it appears in a new chat; test it now with cron_run and args.` : tr(TOOL_APPROVAL),
        ].join('\n')
      },
    }),

    tool({
      name: 'tool_update',
      title: 'Change MCP tool',
      description: 'Change the name, description, parameters, the read_only flag or the code of your tool. New code or parameters wait for approval again, and the tool is unavailable until then; the name and description need no approval (they update in a new chat).',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        tool: z.string().min(1).describe('Name (my_…) or id of the tool'),
        name: z.string().min(1).max(40).optional(),
        description: z.string().min(1).max(1000).optional(),
        params: paramsInput.optional(),
        read_only: z.boolean().optional(),
        code: z.string().min(1).optional(),
      }),
      async run({ tool: ref, read_only, ...change }, { config }) {
        const before = await guard(() => findScript(ref))
        if (before.kind !== 'tool') throw new ToolError(t`“${before.name}” is a cron script, change it with cron_update`)
        const updated = await guard(() => updateScript(before, { ...change, readOnly: read_only }))
        const s = updated.codeHash !== before.codeHash ? autoApprove(config, updated) : updated
        const changed = s.codeHash !== before.codeHash
        return [
          t`Updated ${s.name}: ${statusOf(s) === 'active' ? t`available` : tr(STATUS_LABELS[statusOf(s)])}.`,
          changed && statusOf(s) === 'pending' ? t`The new version is unavailable until approval. ${tr(TOOL_APPROVAL)}` : null,
          !changed ? t`The changes show in a new chat.` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'cron_enable',
      title: 'Turn a script on or off',
      description: 'Turn a script off or back on (approved code only). After approval a script turns on by itself — no need to call this.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ script: refInput, enabled: z.boolean() }),
      async run({ script, enabled }) {
        const s = await guard(() => findScript(script))
        await guard(() => setScriptEnabled(s, enabled))
        syncSchedules()
        const next = enabled ? nextRun(s.schedule) : null
        return enabled ? t`“${s.name}” turned on${next ? t`, next run ${formatWhen(next)}` : ''}.` : t`“${s.name}” turned off.`
      },
    }),

    tool({
      name: 'cron_run',
      title: 'Run a script now',
      description: 'Run an approved script or MCP tool right now and get the result, log and error — to test it. For a tool pass args.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({ script: refInput, args: z.record(z.string(), z.unknown()).optional().describe('Arguments for the MCP tool') }),
      async run({ script, args }) {
        const s = await guard(() => findScript(script))
        if (s.approvedHash !== s.codeHash) throw new ToolError(t`The code of “${s.name}” is not approved. ${s.kind === 'tool' ? tr(TOOL_APPROVAL) : tr(APPROVAL)}`)
        const run =
          s.kind === 'tool' && s.spec
            ? (() => {
                const parsed = inputSchemaOf(s.spec).safeParse(args ?? {})
                if (!parsed.success) throw new ToolError(t`Invalid args: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
                return executeTool(s.id, parsed.data)
              })()
            : executeScript(s.id, 'assistant')
        const r = await run.catch((e: Error) => {
          throw new ToolError(e.message)
        })
        return [
          t`${r.ok ? t`Done` : t`Error`} in ${(r.durationMs / 1000).toFixed(1)} s, requests: ${r.fetches}`,
          r.error ? t`Error: ${r.error}` : null,
          r.output ? t`Result:
${r.output}` : null,
          r.logs.length ? t`Log:
${r.logs.join('\n')}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'cron_logs',
      title: 'Script runs',
      description: 'A script\'s latest runs: time, result, error, log.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ script: refInput, limit: z.number().int().min(1).max(20).default(5) }),
      async run({ script, limit }) {
        const s = await guard(() => findScript(script))
        const runs = listRuns(s.id, limit)
        if (runs.length === 0) return t`“${s.name}” has not run yet.`
        return [
          t`“${s.name}”, latest runs:`,
          ...runs.map((r) =>
            [
              t`• ${formatWhen(r.startedAt)} (${r.trigger}) — ${r.ok ? t`ok` : t`error`}, ${(r.durationMs / 1000).toFixed(1)} s`,
              r.error ? t`  error: ${truncate(r.error, 200)}` : null,
              r.output ? t`  result: ${truncate(r.output, 300)}` : null,
              r.logs ? t`  log: ${truncate(r.logs.replace(/\n/g, ' | '), 300)}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ].join('\n')
      },
    }),

    tool({
      name: 'cron_delete',
      title: 'Delete script',
      description: 'Delete a script with its run history and memory. Ask the user first and pass confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ script: refInput, confirm: z.boolean().optional() }),
      async run({ script, confirm }) {
        const s = await guard(() => findScript(script))
        if (confirm !== true) return t`Not deleted. Ask the user and repeat with confirm: true.
To be deleted: “${s.name}” (${s.id})`
        deleteScript(s.id)
        syncSchedules()
        return t`Deleted “${s.name}”.`
      },
    }),

    tool({
      name: 'script_secrets',
      title: 'Secrets for scripts and tools',
      description: 'Secret names for cron scripts and MCP tools: the ones the user added and the shared connector settings, with the hosts they may be sent to. Values are not available — write {{secret:NAME}} in the code.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const list = listSecrets()
        const { connectorValues } = await import('../../scripts/connector-secrets')
        // Names only: values of shared connector settings are not shown, secret or not.
        const shared = connectorValues()
        if (list.length === 0 && shared.length === 0)
          return t`No secrets. Ask the user to add them in the admin panel → Scripts → Secrets (for example TELEGRAM_TOKEN for api.telegram.org) or to share connector settings.`
        return [
          list.length ? t`Secrets (in code — {{secret:NAME}}; substituted only for their own hosts):` : null,
          ...list.map((s) => `• ${s.name} → ${s.hosts.join(', ')}${s.description ? ` — ${s.description}` : ''}`),
          shared.length ? t`Connector settings (the same {{secret:NAME}} form):` : null,
          ...shared.map((v) => `• ${v.name} — ${v.label}${v.secret ? t` · secret → ${v.hosts.join(', ')}` : t` · a plain value, may start a url`}`),
          shared.length ? t`Connector services are usually on the local network — access to it is needed in the script settings.` : null,
          limitsLine(config),
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),
  ],
})
