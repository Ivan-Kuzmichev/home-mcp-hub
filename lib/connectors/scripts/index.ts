import { z } from 'zod'
import { formatAgo, formatWhen } from '../../format'
import { logger } from '../../logger'
import { executeScript, syncSchedules } from '../../scripts/scheduler'
import { LIMITS, SANDBOX_API_DOC } from '../../scripts/sandbox'
import { listSecrets } from '../../scripts/secrets'
import {
  approveScript,
  createScript,
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
    help: 'Код от ассистента сразу одобряется и включается, без проверки в админке. Скрипт выполнится по расписанию, и ты его не увидишь заранее',
    widget: 'switch',
  }),
  allowExternal: field(z.boolean().default(true), {
    label: 'Доступ к внешним адресам',
    help: 'fetch к сайтам и API в интернете (Telegram, погода и т. п.)',
    widget: 'switch',
  }),
  allowLocal: field(z.boolean().default(false), {
    label: 'Доступ к локальной сети',
    help: 'fetch к NAS, контейнерам, роутеру и localhost. Скрипт сможет ходить в сервисы напрямую, мимо инструментов хаба',
    widget: 'switch',
  }),
})
type Config = z.output<typeof configSchema>
const tool = toolFor<Config>()

const APPROVAL = 'Код ждёт одобрения пользователя в админке хаба → «Скрипты»; после одобрения скрипт включится сам.'

/** «Без одобрения»: the assistant's code is approved (and so enabled) as soon as it is saved. */
function autoApprove(config: Config, s: Script): Script {
  if (!config.autoApprove || s.approvedHash === s.codeHash) return s
  approveScript(s.id, s.codeHash)
  logger.info({ script: s.id }, 'script auto-approved')
  syncSchedules()
  return findScript(s.id)
}

function networkLine(c: Config): string {
  if (c.allowExternal && c.allowLocal) return 'fetch может ходить и во внешние адреса, и в локальную сеть.'
  if (c.allowLocal) return 'fetch может ходить только в локальную сеть (NAS, контейнеры, localhost); интернет закрыт.'
  if (c.allowExternal) return 'fetch может ходить только во внешние адреса; локальная сеть закрыта.'
  return 'Сеть скриптам выключена: fetch не работает, доступны только hub.tool и state.'
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

const refInput = z.string().min(1).describe('Id (sc_…) или имя скрипта из cron_list')

export const scripts = defineConnector<Config>({
  id: 'scripts',
  name: 'Cron-скрипты',
  description: 'JS-скрипты по расписанию, код одобряет пользователь',
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
      tools.includes('cron_secrets') ? 'Секреты — только заглушками {{secret:ИМЯ}} (список — cron_secrets), значения тебе недоступны.' : 'Секреты — только заглушками {{secret:ИМЯ}}, значения тебе недоступны.',
    ].join(' ')
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
      title: 'Cron-скрипты',
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
          status === 'rejected' && s.rejectReason ? `Причина отказа: ${s.rejectReason}` : null,
          status === 'pending' ? APPROVAL : null,
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
        const updated = await guard(() => updateScript(before, change))
        // Only new code is auto-approved: a script the admin switched off stays off.
        const s = updated.codeHash !== before.codeHash ? autoApprove(config, updated) : updated
        syncSchedules()
        const codeChanged = s.codeHash !== before.codeHash
        return [`Обновлён «${s.name}»: ${STATUS_LABELS[statusOf(s)]}.`, codeChanged && statusOf(s) === 'pending' ? `Новый код выключен до одобрения. ${APPROVAL}` : null].filter(Boolean).join('\n')
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
      description: 'Запустить одобренный скрипт прямо сейчас и получить результат, лог и ошибку — чтобы проверить его.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({ script: refInput }),
      async run({ script }) {
        const s = await guard(() => findScript(script))
        if (s.approvedHash !== s.codeHash) throw new ToolError(`Код «${s.name}» не одобрен. ${APPROVAL}`)
        const r = await executeScript(s.id, 'assistant').catch((e: Error) => {
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
