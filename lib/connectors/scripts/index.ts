import { z } from 'zod'
import { formatAgo, formatWhen } from '../../format'
import { executeScript, syncSchedules } from '../../scripts/scheduler'
import { LIMITS, SANDBOX_API_DOC } from '../../scripts/sandbox'
import { listSecrets } from '../../scripts/secrets'
import {
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
import { defineConnector, toolFor, ToolError } from '../types'

const configSchema = z.object({})
type Config = z.output<typeof configSchema>
const tool = toolFor<Config>()

const APPROVAL = 'Код ждёт одобрения пользователя в админке хаба → «Скрипты». После одобрения включи его через cron_enable.'

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

  async test() {
    const list = listScripts()
    const active = list.filter((s) => statusOf(s) === 'active').length
    const pending = list.filter((s) => statusOf(s) === 'pending').length
    return {
      ok: true,
      summary: `${list.length} ${plural(list.length, ['скрипт', 'скрипта', 'скриптов'])}`,
      details: [`включено ${active}`, pending ? `ждут одобрения ${pending}` : null].filter((d): d is string => !!d),
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
      description: `Создать JS-скрипт, который хаб будет запускать по cron-расписанию. Код не запускается, пока пользователь не одобрит его в админке; затем включи его через cron_enable.\n${SANDBOX_API_DOC}`,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      inputSchema: z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(500).optional().describe('Что делает скрипт — пользователь увидит это при одобрении'),
        schedule: z.string().describe('Cron из 5 полей: «*/15 * * * *», «0 9 * * *» (время хаба)'),
        code: z.string().min(1),
      }),
      async run(args) {
        const s = await guard(() => createScript(args))
        return [`Создан «${s.name}» (${s.id}), расписание \`${s.schedule}\`.`, APPROVAL].join('\n')
      },
    }),

    tool({
      name: 'cron_update',
      title: 'Изменить cron-скрипт',
      description: 'Изменить имя, описание, расписание или код. Новый код снова ждёт одобрения, а скрипт до него выключается; смена расписания одобрения не требует.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        script: refInput,
        name: z.string().min(1).max(80).optional(),
        description: z.string().max(500).optional(),
        schedule: z.string().optional(),
        code: z.string().min(1).optional(),
      }),
      async run({ script, ...change }) {
        const before = await guard(() => findScript(script))
        const s = await guard(() => updateScript(before, change))
        syncSchedules()
        const codeChanged = s.codeHash !== before.codeHash
        return [`Обновлён «${s.name}»: ${STATUS_LABELS[statusOf(s)]}.`, codeChanged && statusOf(s) === 'pending' ? `Новый код выключен до одобрения. ${APPROVAL}` : null].filter(Boolean).join('\n')
      },
    }),

    tool({
      name: 'cron_enable',
      title: 'Включить или выключить скрипт',
      description: 'Включить скрипт по расписанию (только одобренный код) или выключить.',
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
        if (list.length === 0) return 'Секретов нет. Попроси пользователя добавить их в админке → «Скрипты» → «Секреты» (например TELEGRAM_TOKEN для api.telegram.org).'
        return [
          'Секреты (в коде — {{secret:ИМЯ}}; подставляются только для своих хостов):',
          ...list.map((s) => `• ${s.name} → ${s.hosts.join(', ')}${s.description ? ` — ${s.description}` : ''}`),
          `Лимиты запуска: ${LIMITS.timeMs / 1000} с, ${LIMITS.fetches} запросов.`,
        ].join('\n')
      },
    }),
  ],
})
