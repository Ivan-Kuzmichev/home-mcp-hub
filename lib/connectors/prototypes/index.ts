import { z } from 'zod'
import {
  getBySlug,
  isExpired,
  listPrototypes,
  MAX_TOOL_HTML_BYTES,
  PIN_PATTERN,
  PrototypeError,
  publicUrl,
  publish,
  remove,
  slugFrom,
  totalSize,
  update,
  type Expiry,
  type Prototype,
} from '../../prototypes/store'
import { formatSize, plural, truncate } from '../format'
import { defineConnector, toolFor, ToolError } from '../types'

const configSchema = z.object({})
type Config = z.output<typeof configSchema>
const tool = toolFor<Config>()

const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' })

export function expiryText(p: Pick<Prototype, 'expiresAt'>): string {
  if (!p.expiresAt) return 'бессрочно'
  return isExpired(p) ? `истёк ${dayMonth.format(p.expiresAt).replace('.', '')}` : `до ${dayMonth.format(p.expiresAt).replace('.', '')}`
}

const expiresInput = z.enum(['never', '7d', '30d']).describe('Срок жизни: never — бессрочно, 7d или 30d')
const pinInput = z.string().regex(PIN_PATTERN, 'Пин — от 4 до 8 цифр').describe('Пинкод из 4–8 цифр для просмотра')
const refInput = z.string().min(1).describe('Slug или ссылка на прототип из prototype_list')

function find(ref: string): Prototype {
  const p = getBySlug(slugFrom(ref))
  if (!p) throw new ToolError(`Прототип «${ref}» не найден — посмотри prototype_list`)
  return p
}

/** Storage errors are user-facing messages already. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof PrototypeError) throw new ToolError(e.message)
    throw e
  }
}

export const prototypes = defineConnector<Config>({
  id: 'prototypes',
  name: 'Прототипы',
  description: 'Хостинг HTML-страниц по ссылке',
  builtin: true,
  configSchema,

  async test() {
    const list = listPrototypes()
    return {
      ok: true,
      summary: `${list.length} ${plural(list.length, ['прототип', 'прототипа', 'прототипов'])}`,
      details: [`${formatSize(totalSize())} на диске`],
    }
  },

  tools: [
    tool({
      name: 'prototype_publish',
      title: 'Опубликовать прототип',
      description:
        'Опубликовать самодостаточный HTML (стили и скрипты внутри, картинки как data-URI, CDN можно) и получить публичную ссылку. До 1 МБ. Страница открывается без входа; с пином — только по пинкоду.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe('Название — видно на странице пинкода и в админке'),
        html: z.string().min(1).describe('Полный HTML-документ'),
        pin: pinInput.optional(),
        expires: expiresInput.default('never'),
      }),
      async run({ title, html, pin, expires }) {
        const p = await guard(() => publish({ title, html, pin, expiry: expires as Expiry, maxBytes: MAX_TOOL_HTML_BYTES }))
        return [`Опубликовано: «${p.title}»`, publicUrl(p.slug), `${pin ? 'Пин задан' : 'Без пина'} · ${expiryText(p)} · ${formatSize(p.sizeBytes)}`].join('\n')
      },
    }),

    tool({
      name: 'prototype_update',
      title: 'Обновить прототип',
      description: 'Заменить HTML, название, пин или срок прототипа. Ссылка не меняется. Смена пина сбрасывает доступ у всех, кто уже вводил старый.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        prototype: refInput,
        html: z.string().min(1).optional().describe('Новый полный HTML'),
        title: z.string().min(1).max(200).optional(),
        pin: pinInput.optional().describe('Новый пинкод'),
        remove_pin: z.boolean().optional().describe('true — открыть без пина'),
        expires: expiresInput.optional().describe('Новый срок, считается от сегодня'),
      }),
      async run(args) {
        const p = find(args.prototype)
        if (args.pin && args.remove_pin) throw new ToolError('Либо pin, либо remove_pin')
        const pin = args.remove_pin ? null : args.pin
        if (args.html === undefined && args.title === undefined && pin === undefined && args.expires === undefined) throw new ToolError('Нечего менять')
        const next = await guard(() => update(p, { html: args.html, title: args.title, pin, expiry: args.expires as Expiry | undefined, maxBytes: MAX_TOOL_HTML_BYTES }))
        const changes = [
          args.html !== undefined && `HTML → v${next.version}`,
          args.title !== undefined && 'название',
          pin === null && 'пин снят',
          typeof pin === 'string' && 'пин сменён',
          args.expires !== undefined && `срок: ${expiryText(next)}`,
        ].filter(Boolean)
        return [`Обновлено «${next.title}»: ${changes.join(', ')}`, publicUrl(next.slug)].join('\n')
      },
    }),

    tool({
      name: 'prototype_list',
      title: 'Список прототипов',
      description: 'Опубликованные прототипы: ссылка, пин, просмотры, срок, дата обновления.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      async run({ limit }) {
        const list = listPrototypes()
        if (list.length === 0) return 'Прототипов пока нет.'
        const lines = list.slice(0, limit).map((p) => {
          const parts = [p.pinHash ? 'пин' : 'открыт', `${p.views} ${plural(p.views, ['просмотр', 'просмотра', 'просмотров'])}`, expiryText(p), `обновлён ${p.updatedAt.toISOString().slice(0, 10)}`]
          return `• «${truncate(p.title, 60)}» — ${publicUrl(p.slug)} · ${parts.join(' · ')}`
        })
        return [`${list.length} ${plural(list.length, ['прототип', 'прототипа', 'прототипов'])}:`, ...lines].join('\n')
      },
    }),

    tool({
      name: 'prototype_delete',
      title: 'Удалить прототип',
      description: 'Удалить прототип со всеми версиями; ссылка перестанет работать. Необратимо: сначала переспроси пользователя и передай confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        prototype: refInput,
        confirm: z.boolean().optional().describe('true — пользователь подтвердил удаление'),
      }),
      async run({ prototype: ref, confirm }) {
        const p = find(ref)
        if (confirm !== true) return `Не удалено. Переспроси пользователя и повтори с confirm: true.\nБудет удалён: «${p.title}» (${publicUrl(p.slug)})`
        remove(p)
        return `Удалён прототип «${p.title}»`
      },
    }),
  ],
})
