import { z } from 'zod'
import { formatAgo, formatWhen } from '../../format'
import { logger } from '../../logger'
import { executeScript, executeTool, syncSchedules } from '../../scripts/scheduler'
import { LIMITS, SANDBOX_API_DOC } from '../../scripts/sandbox'
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

const configSchema = z.object({
  autoApprove: field(z.boolean().default(false), {
    label: 'Без одобрения',
    help: 'Код от ассистента — cron-скрипты и MCP-инструменты — сразу одобряется и включается, без проверки в админке. Ты не увидишь его заранее',
    widget: 'switch',
  }),
  allowExternal: field(z.boolean().default(true), {
    label: 'Доступ к внешним адресам',
    help: 'fetch к сайтам и API в интернете (Telegram, погода и т. п.)',
    widget: 'switch',
  }),
  allowLocal: field(z.boolean().default(false), {
    label: 'Доступ к локальной сети',
    help: 'fetch к NAS, контейнерам, роутеру и localhost, плюс инструменты хаба с записью через hub.tool (torrent_add, paperless_update…). Скрипт сможет менять данные в домашних сервисах',
    widget: 'switch',
  }),
})
type Config = z.output<typeof configSchema>
const tool = toolFor<Config>()

const APPROVAL =
  'Код ждёт одобрения пользователя в админке хаба → «Скрипты»; после одобрения скрипт включится сам. Если пользователь отклонит, новый скрипт удалится, а изменение откатится к прежней версии.'

/** «Без одобрения»: the assistant's code is approved (and so enabled) as soon as it is saved. */
function autoApprove(config: Config, s: Script): Script {
  if (!config.autoApprove || s.approvedHash === s.codeHash) return s
  approveScript(s.id, s.codeHash)
  logger.info({ script: s.id }, 'script auto-approved')
  syncSchedules()
  return findScript(s.id)
}

function networkLine(c: Config): string {
  const hub = c.allowLocal ? ' hub.tool — любые инструменты хаба, включая запись.' : ' hub.tool — только инструменты для чтения.'
  if (c.allowExternal && c.allowLocal) return `fetch может ходить и во внешние адреса, и в локальную сеть.${hub}`
  if (c.allowLocal) return `fetch может ходить только в локальную сеть (NAS, контейнеры, localhost); интернет закрыт.${hub}`
  if (c.allowExternal) return `fetch может ходить только во внешние адреса; локальная сеть закрыта.${hub}`
  return `Сеть скриптам выключена: fetch не работает, доступны только hub.tool и state.${hub}`
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
      'MCP-инструмент',
      describeParams(s.spec),
      s.spec?.readOnly ? 'только чтение' : 'меняет данные',
      status === 'active' ? 'доступен' : STATUS_LABELS[status],
      s.lastRunAt ? `последний вызов ${formatAgo(s.lastRunAt)} — ${s.lastRunOk ? 'ок' : 'ошибка'}` : null,
    ].filter(Boolean)
    return `• ${parts.join(' · ')}`
  }
  const next = status === 'active' ? nextRun(s.schedule) : null
  const parts = [
    `«${s.name}» (${s.id})`,
    `\`${s.schedule}\``,
    STATUS_LABELS[status],
    next ? `следующий запуск ${formatWhen(next)}` : null,
    s.lastRunAt ? `последний ${formatAgo(s.lastRunAt)} — ${s.lastRunOk ? 'ок' : 'ошибка'}` : null,
  ].filter(Boolean)
  return `• ${parts.join(' · ')}`
}

const refInput = z.string().min(1).describe('Id (sc_…) или имя скрипта / инструмента из cron_list')

const TOOL_APPROVAL =
  'Инструмент ждёт одобрения пользователя в админке хаба → «Скрипты». После одобрения он появится в новом чате (в текущем список инструментов не обновляется); проверить сейчас можно через cron_run с args.'

const paramsInput = z
  .array(paramInput)
  .max(MAX_PARAMS)
  .describe('Параметры: name (латиница, snake_case), type (string | number | boolean | enum), description, required (по умолчанию true), options — для enum')

export const scripts = defineConnector<Config>({
  id: 'scripts',
  name: 'Скрипты',
  description: 'JS-скрипты по расписанию и свои MCP-инструменты, код одобряет пользователь',
  builtin: true,
  configSchema,

  instructions(c, { tools }) {
    const writes = ['cron_create', 'cron_update'].filter((t) => tools.includes(t))
    if (!tools.some((t) => t.startsWith('cron_'))) return null
    if (writes.length === 0) return `Cron-скрипты: можно смотреть и запускать существующие; создавать и менять код нельзя. ${networkLine(c)}`
    const verb = writes.length > 1 ? 'отправляют' : 'отправляет'
    return [
      c.autoApprove
        ? `Cron-скрипты: ${writes.join('/')} сразу включают скрипт — одобрения нет, поэтому покажи пользователю код и расписание, прежде чем сохранять.`
        : `Cron-скрипты: ${writes.join('/')} ${verb} код на одобрение пользователю; одобренный скрипт включается сам, запускать можно только одобренный.`,
      networkLine(c),
      tools.includes('tool_create')
        ? `Свои MCP-инструменты: tool_create/tool_update — JS с параметрами, который потом вызываешь ты сам (имя с префиксом my_); после ${c.autoApprove ? 'сохранения' : 'одобрения'} он появится в новом чате, в текущем проверяй через cron_run с args.`
        : null,
      tools.includes('cron_secrets') ? 'Секреты — только заглушками {{secret:ИМЯ}} (список — cron_secrets), значения тебе недоступны.' : 'Секреты — только заглушками {{secret:ИМЯ}}, значения тебе недоступны.',
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
      summary: `${list.length} ${plural(list.length, ['скрипт', 'скрипта', 'скриптов'])}`,
      details: [`включено ${active}`, pending ? `ждут одобрения ${pending}` : null, c.autoApprove ? 'без одобрения' : null].filter((d): d is string => !!d),
    }
  },

  tools: [
    tool({
      name: 'cron_list',
      title: 'Скрипты и инструменты',
      description: 'Список скриптов: расписание, статус (ждёт одобрения / одобрен / включён), следующий и последний запуск.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run() {
        const list = listScripts()
        if (list.length === 0) return 'Скриптов пока нет. Создать — cron_create.'
        return [`${list.length} ${plural(list.length, ['скрипт', 'скрипта', 'скриптов'])}:`, ...list.map(line)].join('\n')
      },
    }),

    tool({
      name: 'cron_get',
      title: 'Скрипт',
      description: 'Код, расписание, статус и последние запуски скрипта.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ script: refInput }),
      async run({ script }) {
        const s = await guard(() => findScript(script))
        const status = statusOf(s)
        return [
          line(s),
          s.description ? `Описание: ${s.description}` : null,
          s.kind === 'tool' && s.spec?.params.length ? `Параметры:\n${s.spec.params.map((p) => `  ${p.name}${p.required ? '' : '?'} (${p.type === 'enum' ? (p.options ?? []).join('|') : p.type})${p.description ? ` — ${p.description}` : ''}`).join('\n')}` : null,
          status === 'rejected' && s.rejectReason ? `Причина отказа: ${s.rejectReason}` : null,
          status === 'pending' ? (s.kind === 'tool' ? TOOL_APPROVAL : APPROVAL) : null,
          `Код:\n\`\`\`js\n${s.code}\n\`\`\``,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'cron_create',
      title: 'Создать cron-скрипт',
      description: `Создать JS-скрипт, который хаб будет запускать по cron-расписанию. Обычно код ждёт одобрения пользователя в админке и после него включается сам; если в хабе выключено одобрение — включается сразу (ответ скажет, какой случай).\n${SANDBOX_API_DOC}`,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(500).optional().describe('Что делает скрипт — пользователь увидит это при одобрении'),
        schedule: z.string().describe('Cron из 5 полей: «*/15 * * * *», «0 9 * * *» (время хаба)'),
        code: z.string().min(1),
      }),
      async run(args, { config }) {
        const s = autoApprove(config, await guard(() => createScript(args)))
        const next = statusOf(s) === 'active' ? nextRun(s.schedule) : null
        return [
          `Создан «${s.name}» (${s.id}), расписание \`${s.schedule}\`.`,
          statusOf(s) === 'active' ? `Включён без одобрения${next ? `, следующий запуск ${formatWhen(next)}` : ''}. Проверить — cron_run.` : APPROVAL,
        ].join('\n')
      },
    }),

    tool({
      name: 'cron_update',
      title: 'Изменить cron-скрипт',
      description: 'Изменить имя, описание, расписание или код. Новый код снова ждёт одобрения, а скрипт до него выключается (если одобрение не выключено в хабе); смена расписания одобрения не требует.',
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
        if (before.kind === 'tool') throw new ToolError(`${before.name} — MCP-инструмент, меняй его через tool_update`)
        const updated = await guard(() => updateScript(before, change))
        // Only new code is auto-approved: a script the admin switched off stays off.
        const s = updated.codeHash !== before.codeHash ? autoApprove(config, updated) : updated
        syncSchedules()
        const codeChanged = s.codeHash !== before.codeHash
        return [`Обновлён «${s.name}»: ${STATUS_LABELS[statusOf(s)]}.`, codeChanged && statusOf(s) === 'pending' ? `Новый код выключен до одобрения. ${APPROVAL}` : null].filter(Boolean).join('\n')
      },
    }),

    tool({
      name: 'tool_create',
      title: 'Создать MCP-инструмент',
      description: `Создать свой MCP-инструмент: JS-код с параметрами, который ты потом вызываешь сам, как любой другой инструмент (например «курс валюты», «рейтинг фильма по API с ключом пользователя»). Имя получит префикс my_. Описание — то, что ты увидишь в списке инструментов: когда вызывать и что вернёт. Код видит аргументы в args, результат — через return (текст или объект, до 10 КБ), лимит 25 с. Обычно ждёт одобрения пользователя; после него доступен в новом чате.\n${SANDBOX_API_DOC}`,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        name: z.string().min(1).max(40).describe('Имя, например eth_price → my_eth_price'),
        description: z.string().min(1).max(1000).describe('Для модели: что делает, когда вызывать, что возвращает'),
        params: paramsInput.default([]),
        read_only: z.boolean().default(true).describe('true — только читает; false — меняет данные где-то (шлёт сообщения, пишет в сервисы)'),
        code: z.string().min(1),
      }),
      async run({ read_only, ...args }, { config }) {
        const s = autoApprove(config, await guard(() => createTool({ ...args, readOnly: read_only })))
        return [
          `Создан ${s.name} (${s.id}): ${describeParams(s.spec)}.`,
          statusOf(s) === 'active' ? 'Доступен без одобрения — появится в новом чате; проверить сейчас — cron_run с args.' : TOOL_APPROVAL,
        ].join('\n')
      },
    }),

    tool({
      name: 'tool_update',
      title: 'Изменить MCP-инструмент',
      description: 'Изменить имя, описание, параметры, флаг read_only или код своего инструмента. Новый код или параметры снова ждут одобрения, и до него инструмент недоступен; имя и описание — без одобрения (обновятся в новом чате).',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        tool: z.string().min(1).describe('Имя (my_…) или id инструмента'),
        name: z.string().min(1).max(40).optional(),
        description: z.string().min(1).max(1000).optional(),
        params: paramsInput.optional(),
        read_only: z.boolean().optional(),
        code: z.string().min(1).optional(),
      }),
      async run({ tool: ref, read_only, ...change }, { config }) {
        const before = await guard(() => findScript(ref))
        if (before.kind !== 'tool') throw new ToolError(`«${before.name}» — cron-скрипт, меняй его через cron_update`)
        const updated = await guard(() => updateScript(before, { ...change, readOnly: read_only }))
        const s = updated.codeHash !== before.codeHash ? autoApprove(config, updated) : updated
        const changed = s.codeHash !== before.codeHash
        return [
          `Обновлён ${s.name}: ${statusOf(s) === 'active' ? 'доступен' : STATUS_LABELS[statusOf(s)]}.`,
          changed && statusOf(s) === 'pending' ? `Новая версия недоступна до одобрения. ${TOOL_APPROVAL}` : null,
          !changed ? 'Изменения видны в новом чате.' : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'cron_enable',
      title: 'Включить или выключить скрипт',
      description: 'Выключить скрипт или включить обратно (только одобренный код). После одобрения скрипт включается сам — вызывать не нужно.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ script: refInput, enabled: z.boolean() }),
      async run({ script, enabled }) {
        const s = await guard(() => findScript(script))
        await guard(() => setScriptEnabled(s, enabled))
        syncSchedules()
        const next = enabled ? nextRun(s.schedule) : null
        return enabled ? `«${s.name}» включён${next ? `, следующий запуск ${formatWhen(next)}` : ''}.` : `«${s.name}» выключен.`
      },
    }),

    tool({
      name: 'cron_run',
      title: 'Запустить скрипт сейчас',
      description: 'Запустить одобренный скрипт или MCP-инструмент прямо сейчас и получить результат, лог и ошибку — чтобы проверить его. Для инструмента передай args.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({ script: refInput, args: z.record(z.string(), z.unknown()).optional().describe('Аргументы для MCP-инструмента') }),
      async run({ script, args }) {
        const s = await guard(() => findScript(script))
        if (s.approvedHash !== s.codeHash) throw new ToolError(`Код «${s.name}» не одобрен. ${s.kind === 'tool' ? TOOL_APPROVAL : APPROVAL}`)
        const run =
          s.kind === 'tool' && s.spec
            ? (() => {
                const parsed = inputSchemaOf(s.spec).safeParse(args ?? {})
                if (!parsed.success) throw new ToolError(`Неверные args: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
                return executeTool(s.id, parsed.data)
              })()
            : executeScript(s.id, 'assistant')
        const r = await run.catch((e: Error) => {
          throw new ToolError(e.message)
        })
        return [
          `${r.ok ? 'Готово' : 'Ошибка'} за ${(r.durationMs / 1000).toFixed(1)} с, запросов: ${r.fetches}`,
          r.error ? `Ошибка: ${r.error}` : null,
          r.output ? `Результат:\n${r.output}` : null,
          r.logs.length ? `Лог:\n${r.logs.join('\n')}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'cron_logs',
      title: 'Запуски скрипта',
      description: 'Последние запуски скрипта: время, результат, ошибка, лог.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ script: refInput, limit: z.number().int().min(1).max(20).default(5) }),
      async run({ script, limit }) {
        const s = await guard(() => findScript(script))
        const runs = listRuns(s.id, limit)
        if (runs.length === 0) return `«${s.name}» ещё не запускался.`
        return [
          `«${s.name}», последние запуски:`,
          ...runs.map((r) =>
            [
              `• ${formatWhen(r.startedAt)} (${r.trigger}) — ${r.ok ? 'ок' : 'ошибка'}, ${(r.durationMs / 1000).toFixed(1)} с`,
              r.error ? `  ошибка: ${truncate(r.error, 200)}` : null,
              r.output ? `  результат: ${truncate(r.output, 300)}` : null,
              r.logs ? `  лог: ${truncate(r.logs.replace(/\n/g, ' | '), 300)}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ].join('\n')
      },
    }),

    tool({
      name: 'cron_delete',
      title: 'Удалить скрипт',
      description: 'Удалить скрипт вместе с историей запусков и памятью. Сначала переспроси пользователя и передай confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ script: refInput, confirm: z.boolean().optional() }),
      async run({ script, confirm }) {
        const s = await guard(() => findScript(script))
        if (confirm !== true) return `Не удалено. Переспроси пользователя и повтори с confirm: true.\nБудет удалён: «${s.name}» (${s.id})`
        deleteScript(s.id)
        syncSchedules()
        return `Удалён «${s.name}».`
      },
    }),

    tool({
      name: 'cron_secrets',
      title: 'Секреты для скриптов',
      description: 'Имена секретов, которые пользователь завёл в админке, и хосты, куда их можно отправлять. Значения недоступны — в коде пиши {{secret:ИМЯ}}.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run() {
        const list = listSecrets()
        const { connectorValues } = await import('../../scripts/connector-secrets')
        // Names only: values of shared connector settings are not shown, secret or not.
        const shared = connectorValues()
        if (list.length === 0 && shared.length === 0)
          return 'Секретов нет. Попроси пользователя добавить их в админке → «Скрипты» → «Секреты» (например TELEGRAM_TOKEN для api.telegram.org) или поделиться настройками коннектора.'
        return [
          list.length ? 'Секреты (в коде — {{secret:ИМЯ}}; подставляются только для своих хостов):' : null,
          ...list.map((s) => `• ${s.name} → ${s.hosts.join(', ')}${s.description ? ` — ${s.description}` : ''}`),
          shared.length ? 'Настройки коннекторов (та же запись {{secret:ИМЯ}}):' : null,
          ...shared.map((v) => `• ${v.name} — ${v.label}${v.secret ? ` · секрет → ${v.hosts.join(', ')}` : ' · обычное значение, можно в начало url'}`),
          shared.length ? 'Сервисы коннекторов обычно в локальной сети — нужен доступ к ней в настройках скриптов.' : null,
          `Лимиты запуска: ${LIMITS.timeMs / 1000} с, ${LIMITS.fetches} запросов.`,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),
  ],
})
