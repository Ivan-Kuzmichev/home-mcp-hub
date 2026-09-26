import { z } from 'zod'
import { plural, truncate } from '../format'
import { baseUrl, defineConnector, field, secret, toolFor, ToolError } from '../types'
import { PlClient, type PlDocument } from './client'
import {
  assertVisible,
  batchChanges,
  createLink,
  day,
  diffLine,
  docLine,
  excludedTagId,
  filterParams,
  KIND_LABELS,
  lastBatchId,
  linkUrl,
  markUndone,
  metaLine,
  newBatchId,
  patchOf,
  plan,
  recordChange,
  reviewDocuments,
  snapshot,
  suggestionLine,
  TaxonomyIndex,
  type DocFilter,
  type Snapshot,
} from './logic'

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Адрес в локальной сети', placeholder: 'http://paperless:8000' }),
    apiToken: secret({
      label: 'API-токен',
      help: 'Лучше отдельного пользователя Paperless: просмотр и изменение документов, тегов, корреспондентов и типов. Токен — в профиле пользователя',
      section: 'connection',
    }),
    webUrl: field(
      z
        .string()
        .trim()
        .url('Нужен адрес вида https://paperless.example.com')
        .transform((v) => v.replace(/\/+$/, ''))
        .optional(),
      { label: 'Адрес веб-интерфейса', placeholder: 'http://192.168.1.10:8000', help: 'Для ссылок «открыть в Paperless» в ответах; пусто — без них', widget: 'url', mono: true, section: 'connection' },
    ),
    excludeTag: field(z.string().trim().default('private'), {
      label: 'Тег-исключение',
      help: 'Документы с этим тегом ассистент не ищет, не читает и не меняет',
      placeholder: 'private',
      section: 'defaults',
    }),
    removeInbox: field(z.boolean().default(true), {
      label: 'Снимать метку «входящие» после разметки',
      help: 'Inbox-теги Paperless убираются, когда ассистент размечает документ',
      widget: 'switch',
      section: 'defaults',
    }),
    rules: field(z.string().trim().max(4000).optional(), {
      label: 'Правила разметки',
      help: 'Свободный текст: ассистент читает его перед каждым разбором',
      placeholder:
        '- тег «налоги» — НДФЛ, декларации, ИНН, вычеты\n- название: «Корреспондент — что это — месяц год»\n- дата документа — дата подписания, не сканирования',
      widget: 'textarea',
      section: 'defaults',
    }),
  })
  .superRefine((c, ctx) => {
    if (!c.apiToken) ctx.addIssue({ code: 'custom', path: ['apiToken'], message: 'Нужен API-токен' })
  })

type Config = z.output<typeof configSchema>

const tool = toolFor<Config>()
const client = (c: Config) => new PlClient({ baseUrl: c.baseUrl, apiToken: c.apiToken })

async function load(c: Config) {
  const pl = client(c)
  const index = new TaxonomyIndex(await pl.taxonomy())
  return { pl, index, excludedId: excludedTagId(index, c.excludeTag) }
}

const webLink = (c: Config, id: number) => (c.webUrl ? `${c.webUrl}/documents/${id}/details` : null)

function rulesBlock(c: Config): string {
  return c.rules ? `Правила разметки (от пользователя):\n${c.rules}\n` : 'Правил разметки нет — держись существующих тегов и названий.\n'
}

/** Run with limited parallelism: Paperless on a NAS does not like 20 requests at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i]!)
      }
    }),
  )
  return out
}

const filterInput = {
  query: z.string().optional().describe('Полнотекстовый поиск по содержимому'),
  tags: z.array(z.string()).optional().describe('Все эти теги (по имени)'),
  correspondent: z.string().optional().describe('Корреспондент (по имени)'),
  document_type: z.string().optional().describe('Тип документа (по имени)'),
  added_after: z.string().optional().describe('Добавлен в Paperless не раньше, ГГГГ-ММ-ДД'),
  added_before: z.string().optional().describe('Добавлен не позже, ГГГГ-ММ-ДД'),
  created_after: z.string().optional().describe('Дата документа не раньше, ГГГГ-ММ-ДД'),
  created_before: z.string().optional().describe('Дата документа не позже, ГГГГ-ММ-ДД'),
}

type FilterArgs = { query?: string; tags?: string[]; correspondent?: string; document_type?: string; added_after?: string; added_before?: string; created_after?: string; created_before?: string }

const toFilter = (a: FilterArgs): DocFilter => ({
  query: a.query,
  tags: a.tags,
  correspondent: a.correspondent,
  documentType: a.document_type,
  addedAfter: a.added_after,
  addedBefore: a.added_before,
  createdAfter: a.created_after,
  createdBefore: a.created_before,
})

const changeInput = z.object({
  id: z.number().int().describe('id документа'),
  title: z.string().optional(),
  created: z.string().optional().describe('Дата документа, ГГГГ-ММ-ДД'),
  correspondent: z.string().nullable().optional().describe('Имя корреспондента; новый создаётся; null — убрать'),
  document_type: z.string().nullable().optional().describe('Имя типа; новый создаётся; null — убрать'),
  tags: z.array(z.string()).optional().describe('Заменить теги этим списком'),
  add_tags: z.array(z.string()).optional().describe('Добавить теги (новые создаются)'),
  remove_tags: z.array(z.string()).optional(),
  keep_inbox: z.boolean().optional().describe('Не снимать метку «входящие»'),
})

export const paperless = defineConnector<Config>({
  id: 'paperless',
  name: 'Paperless',
  description: 'Архив документов (paperless-ngx)',
  docsUrl: 'https://docs.paperless-ngx.com/api/',
  configSchema,

  async test(c) {
    const started = Date.now()
    try {
      const pl = client(c)
      const [info, tax] = await Promise.all([pl.ping(), pl.taxonomy()])
      return {
        ok: true,
        version: info.version ?? undefined,
        summary: `${info.documents} ${plural(info.documents, ['документ', 'документа', 'документов'])}`,
        details: [
          info.version ? `Paperless ${info.version}` : null,
          `${tax.tags.length} ${plural(tax.tags.length, ['тег', 'тега', 'тегов'])}`,
          `ответ ${Date.now() - started} мс`,
        ].filter((d): d is string => !!d),
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'paperless_search',
      title: 'Поиск в Paperless',
      description: 'Поиск документов в Paperless: по содержимому (полнотекстовый), тегам, корреспонденту, типу и датам. Возвращает id, название, дату и метаданные.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ ...filterInput, limit: z.number().int().min(1).max(25).default(10), page: z.number().int().min(1).default(1) }),
      async run(args, { config }) {
        const { pl, index, excludedId } = await load(config)
        const data = await pl.documents({ ...filterParams(toFilter(args), index, excludedId), page_size: args.limit, page: args.page })
        if (data.count === 0) return 'Ничего не найдено.'
        const pages = Math.ceil(data.count / args.limit)
        const head = `Найдено ${data.count} ${plural(data.count, ['документ', 'документа', 'документов'])}${pages > 1 ? `, страница ${args.page} из ${pages}` : ''}:`
        return [head, ...data.results.map((d) => docLine(d, index))].join('\n')
      },
    }),

    tool({
      name: 'paperless_review',
      title: 'Документы для разметки',
      description:
        'Пачка документов для разметки: текущие метаданные, начало распознанного текста, подсказки классификатора Paperless и как размечены прошлые документы того же корреспондента. По умолчанию — неразмеченные (метка «входящие», без корреспондента или без типа). Потом — paperless_update списком изменений.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        ...filterInput,
        scope: z.enum(['unlabeled', 'inbox', 'all']).default('unlabeled').describe('unlabeled — неразмеченные; inbox — только с меткой «входящие»; all — все подходящие под фильтр'),
        limit: z.number().int().min(1).max(20).default(20),
      }),
      async run(args, { config }) {
        const { pl, index, excludedId } = await load(config)
        const { total, docs: brief } = await reviewDocuments(pl, filterParams(toFilter(args), index, excludedId), args.scope, index, args.limit)
        if (brief.length === 0) return `${rulesBlock(config)}\nДокументов для разметки нет.`

        const full = await mapLimit(brief, 5, async (d) => ({ doc: await pl.document(d.id), sug: await pl.suggestions(d.id) }))

        // How the likely correspondents were labeled before: the strongest consistency hint.
        const corrIds = [...new Set(full.map(({ doc, sug }) => doc.correspondent ?? sug?.correspondents[0]).filter((id): id is number => typeof id === 'number'))].slice(0, 6)
        const batchIds = new Set(full.map(({ doc }) => doc.id))
        const examples = await mapLimit(corrIds, 3, async (cid) => {
          const prev = await pl.documents({ correspondent__id: cid, ordering: '-added', page_size: 5, truncate_content: 'true', ...(excludedId !== null ? { tags__id__none: excludedId } : {}) })
          const lines = prev.results.filter((d) => !batchIds.has(d.id)).slice(0, 3).map((d) => `  «${truncate(d.title, 60)}» · ${index.name('document_types', d.document_type) ?? '—'} · [${index.names('tags', d.tags).join(', ')}]`)
          return lines.length ? `${index.name('correspondents', cid)}:\n${lines.join('\n')}` : null
        })

        const blocks = full.map(({ doc, sug }) =>
          [
            `#${doc.id} · добавлен ${day(doc.added)}${doc.original_file_name ? ` · файл ${doc.original_file_name}` : ''}`,
            `Сейчас: ${metaLine(doc, index)}`,
            suggestionLine(sug, index),
            `Текст: ${truncate((doc.content ?? '').replace(/\s+/g, ' ').trim() || '(пусто — нет OCR-текста, глянь paperless_thumbnail)', 800)}`,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        const shownExamples = examples.filter(Boolean)
        return [
          rulesBlock(config),
          `Документов для разметки: ${total}, в этой пачке ${full.length}.${total > full.length ? ' Остальные — следующим вызовом после разметки этих.' : ''}`,
          '',
          blocks.join('\n\n'),
          shownExamples.length ? `\nКак размечены прошлые документы:\n${shownExamples.join('\n')}` : '',
          '\nСправочник тегов/корреспондентов/типов — paperless_taxonomy. Применить — paperless_update (можно с dry_run: true для плана).',
        ].join('\n')
      },
    }),

    tool({
      name: 'paperless_get',
      title: 'Документ Paperless',
      description: 'Метаданные документа, подсказки классификатора и распознанный текст целиком (длинный — частями через offset).',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: z.number().int(),
        offset: z.number().int().min(0).default(0).describe('С какого символа текста'),
        max_chars: z.number().int().min(500).max(20000).default(12000),
      }),
      async run({ id, offset, max_chars }, { config }) {
        const { pl, index, excludedId } = await load(config)
        const doc = await pl.document(id)
        assertVisible(doc, excludedId, config.excludeTag)
        const sug = await pl.suggestions(id)
        const text = (doc.content ?? '').trim()
        const part = text.slice(offset, offset + max_chars)
        const rest = text.length - offset - part.length
        return [
          `#${doc.id} · добавлен ${day(doc.added)}${doc.original_file_name ? ` · файл ${doc.original_file_name}` : ''}`,
          metaLine(doc, index),
          suggestionLine(sug, index),
          webLink(config, id) ? `Открыть в Paperless: ${webLink(config, id)}` : null,
          `\nТекст (${offset}–${offset + part.length} из ${text.length}):\n${part || '(нет OCR-текста — посмотри paperless_thumbnail)'}`,
          rest > 0 ? `\n…ещё ${rest} символов: paperless_get(id: ${id}, offset: ${offset + part.length})` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'paperless_thumbnail',
      title: 'Превью документа',
      description: 'Картинка первой страницы документа — когда OCR-текста нет или он плохой (фото чека, рукопись). Мелкий текст на превью может не читаться.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ id: z.number().int() }),
      async run({ id }, { config }) {
        const { pl, excludedId } = await load(config)
        const doc = await pl.document(id)
        assertVisible(doc, excludedId, config.excludeTag)
        const thumb = await pl.thumbnail(id)
        if (thumb.data.length > 2 * 1024 * 1024) throw new ToolError('Превью больше 2 МБ — не отправляю')
        return { text: `Превью #${id} «${truncate(doc.title, 60)}»`, images: [{ data: thumb.data.toString('base64'), mimeType: thumb.mimeType }] }
      },
    }),

    tool({
      name: 'paperless_taxonomy',
      title: 'Теги, корреспонденты и типы',
      description: 'Все теги, корреспонденты и типы документов Paperless с числом документов — чтобы размечать существующими, а не плодить дубли. Плюс правила разметки пользователя.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const { pl } = await load(config)
        const tax = await pl.taxonomy()
        const list = (items: { name: string; document_count?: number; is_inbox_tag?: boolean }[]) =>
          [...items]
            .sort((a, b) => (b.document_count ?? 0) - (a.document_count ?? 0))
            .slice(0, 300)
            .map((i) => `${i.name}${i.document_count !== undefined ? ` (${i.document_count})` : ''}${i.is_inbox_tag ? ' — «входящие»' : ''}${i.name === config.excludeTag ? ' — скрыт от ассистента' : ''}`)
            .join(', ')
        return [
          rulesBlock(config),
          `Теги: ${list(tax.tags) || '—'}`,
          `Корреспонденты: ${list(tax.correspondents) || '—'}`,
          `Типы: ${list(tax.documentTypes) || '—'}`,
        ].join('\n')
      },
    }),

    tool({
      name: 'paperless_update',
      title: 'Разметить документы',
      description:
        'Изменить метаданные одного или нескольких документов: название, дату, корреспондента, тип, теги (по именам; недостающие создаются). Метка «входящие» снимается. dry_run: true — только показать план. Изменения можно откатить через paperless_undo.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        changes: z.array(changeInput).min(1).max(50),
        dry_run: z.boolean().default(false).describe('true — ничего не менять, показать, что будет'),
      }),
      async run({ changes, dry_run }, { config }) {
        const { pl, index, excludedId } = await load(config)
        const batchId = newBatchId()
        const lines: string[] = []
        let applied = 0
        for (const change of changes) {
          try {
            const doc: PlDocument = await pl.document(change.id)
            assertVisible(doc, excludedId, config.excludeTag)
            const before = snapshot(doc)
            const after: Snapshot = await plan(doc, change, index, pl, { dryRun: dry_run, removeInbox: config.removeInbox })
            const patch = patchOf(before, after)
            if (!dry_run && Object.keys(patch).length) {
              const saved = snapshot(await pl.update(change.id, patch))
              recordChange(batchId, change.id, before, saved)
              applied++
            }
            lines.push(diffLine(change.id, before, after, index))
          } catch (e) {
            lines.push(`#${change.id}: не изменён — ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        const created = index.created.map((c) => `${KIND_LABELS[c.kind]} «${c.name}»`)
        const head = dry_run ? `План для ${changes.length} ${plural(changes.length, ['документа', 'документов', 'документов'])} (ничего не изменено):` : `Обновлено ${applied} из ${changes.length}:`
        return [
          head,
          ...lines,
          created.length ? `${dry_run ? 'Будут созданы' : 'Созданы'}: ${created.join(', ')}` : null,
          !dry_run && applied ? `Откатить: paperless_undo(batch: "${batchId}")` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'paperless_undo',
      title: 'Откатить разметку',
      description: 'Вернуть метаданные документов, как было до пачки paperless_update. Без batch — последняя пачка. Созданные теги и корреспонденты остаются.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ batch: z.string().optional().describe('Id пачки из ответа paperless_update') }),
      async run({ batch }, { config }) {
        const id = batch ?? lastBatchId()
        if (!id) return 'Откатывать нечего.'
        const rows = batchChanges(id)
        if (rows.length === 0) return `Пачка ${id} не найдена или уже откачена.`
        const { pl, index } = await load(config)
        const lines: string[] = []
        for (const row of rows) {
          const before = JSON.parse(row.beforeJson) as Snapshot
          try {
            const current = snapshot(await pl.document(row.documentId))
            await pl.update(row.documentId, patchOf(current, before))
            markUndone(row.id)
            lines.push(diffLine(row.documentId, current, before, index))
          } catch (e) {
            lines.push(`#${row.documentId}: не откачен — ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        return [`Откат пачки ${id}:`, ...lines].join('\n')
      },
    }),

    tool({
      name: 'paperless_link',
      title: 'Ссылка на скачивание',
      description:
        'Ссылка на файл документа (архивный PDF или оригинал). По умолчанию личная: работает 24 часа и только в браузере, где пользователь вошёл в админку хаба. shareable: true — только если пользователь прямо попросил ссылку, чтобы переслать: открывается у любого, один раз, 15 минут.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        id: z.number().int(),
        original: z.boolean().default(false).describe('true — исходный файл, false — архивный PDF'),
        shareable: z.boolean().default(false).describe('true — пересылаемая одноразовая ссылка на 15 минут'),
      }),
      async run({ id, original, shareable }, { config }) {
        const { pl, excludedId } = await load(config)
        const doc = await pl.document(id)
        assertVisible(doc, excludedId, config.excludeTag)
        const { token } = createLink(id, { original, shareable })
        const what = original ? 'оригинал' : 'архивный PDF'
        return [
          `«${truncate(doc.title, 70)}» — ${what}:`,
          linkUrl(token),
          shareable ? 'Пересылаемая: откроется один раз у любого, у кого ссылка, в течение 15 минут.' : 'Личная: 24 часа, открывается только в браузере, где выполнен вход в админку хаба.',
        ].join('\n')
      },
    }),
  ],
})
