import { z } from 'zod'
import { plural, truncate } from '../format'
import { mapLimit } from '../map-limit'
import { baseUrl, defineConnector, field, secret, toolFor, ToolError } from '../types'
import { LINK_KIND_TEXT, linkUrl } from '../../download-links'
import { PaClient, type PaDocument } from './client'
import {
  applyDiff,
  assertVisible,
  batchChanges,
  createLink,
  day,
  diffLine,
  docLine,
  hasChanges,
  headLine,
  isVisible,
  lastBatchId,
  markUndone,
  metaLine,
  newBatchId,
  patchOf,
  plan,
  recordChange,
  searchQuery,
  snapshot,
  TagIndex,
  type DocFilter,
  type Snapshot,
} from './logic'

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Адрес в локальной сети', placeholder: 'http://papra:1221' }),
    apiKey: secret({
      label: 'API-ключ',
      help: 'Создаётся в настройках аккаунта Papra. Права: documents:read, documents:update, tags:read, tags:create; organizations:read, если ID организации ниже не указан; documents:create и documents:delete — для поворота файлов (papra_rotate). Нужен Papra 26.5 или новее',
      section: 'connection',
    }),
    organizationId: field(
      z
        .string()
        .trim()
        .regex(/^org_[a-z0-9]+$/, 'Нужен ID вида org_… из адреса организации в Papra')
        .optional(),
      { label: 'ID организации', placeholder: 'org_…', help: 'Из адреса организации в Papra. Пусто — единственная организация пользователя', mono: true, section: 'connection' },
    ),
    webUrl: field(
      z
        .string()
        .trim()
        .url('Нужен адрес вида https://papra.example.com')
        .transform((v) => v.replace(/\/+$/, ''))
        .optional(),
      { label: 'Адрес веб-интерфейса', placeholder: 'http://192.168.1.10:1221', help: 'Для ссылок «открыть в Papra» в ответах; пусто — без них', widget: 'url', mono: true, section: 'connection' },
    ),
    excludeTag: field(z.string().trim().default('private'), {
      label: 'Тег-исключение',
      help: 'Документы с этим тегом ассистент не ищет, не читает и не меняет',
      placeholder: 'private',
      section: 'defaults',
    }),
    rules: field(z.string().trim().max(4000).optional(), {
      label: 'Правила разметки',
      help: 'Свободный текст: ассистент читает его перед каждым разбором',
      placeholder: '- тег «налоги» — НДФЛ, декларации, ИНН, вычеты\n- название: «Откуда — что это — месяц год»\n- дата документа — дата подписания, не сканирования',
      widget: 'textarea',
      section: 'defaults',
    }),
  })
  .superRefine((c, ctx) => {
    if (!c.apiKey) ctx.addIssue({ code: 'custom', path: ['apiKey'], message: 'Нужен API-ключ' })
  })

type Config = z.output<typeof configSchema>

const tool = toolFor<Config>()
const client = (c: Config) => new PaClient({ baseUrl: c.baseUrl, apiKey: c.apiKey, organizationId: c.organizationId })

async function load(c: Config) {
  const pa = client(c)
  return { pa, index: new TagIndex(await pa.tags()) }
}

function rulesBlock(c: Config): string {
  return c.rules ? `Правила разметки (от пользователя):\n${c.rules}\n` : 'Правил разметки нет — держись существующих тегов и названий.\n'
}

const angleInput = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])

// Mirrors render.ts, which is not imported up front: it pulls in the heavy libraries only when used.
const MAX_FILE_BYTES = 50 * 1024 * 1024
const canPreview = (mimeType: string) => mimeType === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(mimeType)
const canRotate = (mimeType: string) => mimeType === 'application/pdf' || /^image\/(png|jpeg|webp)$/.test(mimeType)

async function download(pa: PaClient, doc: PaDocument): Promise<Buffer> {
  const tooBig = () => new ToolError('Файл больше 50 МБ, обрабатывать его здесь не буду. Скачать — через papra_link')
  if ((doc.originalSize ?? 0) > MAX_FILE_BYTES) throw tooBig()
  const data = Buffer.from(await (await pa.file(doc.id)).arrayBuffer())
  if (data.length > MAX_FILE_BYTES) throw tooBig()
  return data
}

const documentId = z.string().regex(/^doc_[a-z0-9]+$/, 'Нужен id вида doc_…').describe('id документа, doc_…')

const filterInput = {
  query: z.string().max(900).optional().describe('Поиск по названию и содержимому. Понимает синтаксис Papra: name:счёт, content:"договор аренды", OR, NOT'),
  tags: z.array(z.string()).optional().describe('Все эти теги (по имени)'),
  added_after: z.string().optional().describe('Добавлен в Papra не раньше, ГГГГ-ММ-ДД'),
  added_before: z.string().optional().describe('Добавлен не позже, ГГГГ-ММ-ДД'),
  date_after: z.string().optional().describe('Дата документа не раньше, ГГГГ-ММ-ДД'),
  date_before: z.string().optional().describe('Дата документа не позже, ГГГГ-ММ-ДД'),
}

type FilterArgs = { query?: string; tags?: string[]; added_after?: string; added_before?: string; date_after?: string; date_before?: string }

const toFilter = (a: FilterArgs): DocFilter => ({
  query: a.query,
  tags: a.tags,
  addedAfter: a.added_after,
  addedBefore: a.added_before,
  dateAfter: a.date_after,
  dateBefore: a.date_before,
})

const changeInput = z.object({
  id: documentId,
  name: z.string().max(255).optional().describe('Название'),
  date: z.string().nullable().optional().describe('Дата документа, ГГГГ-ММ-ДД; null — убрать'),
  notes: z.string().max(2048).optional().describe('Заметки; пустая строка — убрать'),
  content: z.string().max(500_000).optional().describe('Заменить распознанный текст: то, что ты прочитал на скане через papra_preview. Поиск работает по нему'),
  tags: z.array(z.string().max(64)).optional().describe('Заменить теги этим списком'),
  add_tags: z.array(z.string().max(64)).optional().describe('Добавить теги (новые создаются)'),
  remove_tags: z.array(z.string()).optional(),
})

export const papra = defineConnector<Config>({
  id: 'papra',
  name: 'Papra',
  description: 'Архив документов (Papra)',
  docsUrl: 'https://docs.papra.app/resources/api-endpoints/',
  configSchema,

  instructions(c, { tools }) {
    const has = (t: string) => tools.includes(t)
    if (!tools.some((t) => t.startsWith('papra_'))) return null
    const lines: string[] = []
    if (has('papra_update')) {
      lines.push(
        [
          `Papra: для разметки — ${has('papra_review') ? 'papra_review, затем ' : ''}papra_update списком изменений.`,
          has('papra_tags') ? 'Используй существующие теги из papra_tags.' : null,
          'Для массовой правки сначала покажи план (dry_run), если пользователь не попросил применять сразу.',
          // The rules themselves stay out of the always-loaded text: they arrive with the reads.
          c.rules ? 'У пользователя есть правила разметки — они приходят в ответах papra_review, papra_get и papra_tags; прочитай их перед любой правкой.' : null,
        ]
          .filter(Boolean)
          .join(' '),
      )
    } else {
      lines.push('Papra: документы можно искать и читать; менять метаданные нельзя.')
    }
    if (has('papra_link')) lines.push('Пересылаемую ссылку на документ Papra (shareable) — только по прямой просьбе.')
    return lines.join('\n')
  },

  async test(c) {
    const started = Date.now()
    try {
      const pa = client(c)
      const org = await pa.organization()
      const [count, tags, sample] = await Promise.all([pa.documentCount(), pa.tags(), pa.documents({ pageSize: 1 })])
      // Before 26.5 the list route ignores searchQuery: every search would return all documents.
      const first = sample.documents[0]
      if (first && !('notes' in first)) return { ok: false, summary: 'Нужен Papra 26.5 или новее: эта версия не умеет искать через список документов', details: [] }
      return {
        ok: true,
        summary: `${count} ${plural(count, ['документ', 'документа', 'документов'])}`,
        details: [org.name ? `Организация «${org.name}»` : null, `${tags.length} ${plural(tags.length, ['тег', 'тега', 'тегов'])}`, `ответ ${Date.now() - started} мс`].filter((d): d is string => !!d),
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'papra_search',
      title: 'Поиск в Papra',
      description: 'Поиск документов в Papra: по названию и содержимому, тегам и датам. Возвращает id, название, дату и теги.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ ...filterInput, limit: z.number().int().min(1).max(25).default(10), page: z.number().int().min(1).default(1) }),
      async run(args, { config }) {
        const { pa, index } = await load(config)
        const data = await pa.documents({ searchQuery: searchQuery(toFilter(args), index, config.excludeTag), pageSize: args.limit, pageIndex: args.page - 1 })
        const docs = data.documents.filter((d) => isVisible(d, config.excludeTag))
        if (docs.length === 0) return 'Ничего не найдено.'
        const pages = Math.ceil(data.count / args.limit)
        const head = `Найдено ${data.count} ${plural(data.count, ['документ', 'документа', 'документов'])}${pages > 1 ? `, страница ${args.page} из ${pages}` : ''}:`
        return [head, ...docs.map(docLine)].join('\n')
      },
    }),

    tool({
      name: 'papra_review',
      title: 'Документы для разметки',
      description:
        'Пачка документов для разметки: текущие метаданные, начало распознанного текста и как размечены недавние документы. По умолчанию — неразмеченные (без тегов или без даты). Потом — papra_update списком изменений.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        ...filterInput,
        scope: z.enum(['unlabeled', 'untagged', 'all']).default('unlabeled').describe('unlabeled — без тегов или без даты; untagged — без тегов; all — все подходящие под фильтр'),
        limit: z.number().int().min(1).max(20).default(20),
      }),
      async run(args, { config }) {
        const { pa, index } = await load(config)
        const data = await pa.documents({ searchQuery: searchQuery(toFilter(args), index, config.excludeTag, args.scope), pageSize: args.limit })
        const brief = data.documents.filter((d) => isVisible(d, config.excludeTag))
        if (brief.length === 0) return `${rulesBlock(config)}\nДокументов для разметки нет.`

        const full = await mapLimit(brief, 5, (d) => pa.document(d.id))

        // Papra has no classifier suggestions: recent labeled documents are the consistency hint.
        const batchIds = new Set(full.map((d) => d.id))
        const recent = await pa.documents({ searchQuery: searchQuery({ query: 'has:tags' }, index, config.excludeTag), pageSize: 10 })
        const examples = recent.documents
          .filter((d) => !batchIds.has(d.id) && isVisible(d, config.excludeTag))
          .slice(0, 5)
          .map((d) => `  «${truncate(d.name, 60)}» · ${day(d.documentDate)} · [${d.tags.map((t) => t.name).join(', ')}]`)

        const blocks = full.map((doc) =>
          [`${headLine(doc)}`, `Сейчас: ${metaLine(doc)}`, `Текст: ${truncate((doc.content ?? '').replace(/\s+/g, ' ').trim() || '(пусто — нет распознанного текста, глянь papra_preview)', 800)}`].join('\n'),
        )
        return [
          rulesBlock(config),
          `Документов для разметки: ${data.count}, в этой пачке ${full.length}.${data.count > full.length ? ' Остальные — следующим вызовом после разметки этих.' : ''}`,
          '',
          blocks.join('\n\n'),
          examples.length ? `\nКак размечены недавние документы:\n${examples.join('\n')}` : '',
          '\nСправочник тегов — papra_tags. Применить — papra_update (можно с dry_run: true для плана).',
        ].join('\n')
      },
    }),

    tool({
      name: 'papra_get',
      title: 'Документ Papra',
      description: 'Метаданные документа и распознанный текст целиком (длинный — частями через offset).',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: documentId,
        offset: z.number().int().min(0).default(0).describe('С какого символа текста'),
        max_chars: z.number().int().min(500).max(20000).default(12000),
      }),
      async run({ id, offset, max_chars }, { config }) {
        const pa = client(config)
        const doc = await pa.document(id)
        assertVisible(doc, config.excludeTag)
        const org = config.webUrl ? await pa.organization() : null
        const text = (doc.content ?? '').trim()
        const part = text.slice(offset, offset + max_chars)
        const rest = text.length - offset - part.length
        return [
          config.rules ? rulesBlock(config) : null,
          headLine(doc),
          metaLine(doc),
          org ? `Открыть в Papra: ${config.webUrl}/organizations/${org.id}/documents/${id}` : null,
          `\nТекст (${offset}–${offset + part.length} из ${text.length}):\n${part || '(нет распознанного текста — посмотри papra_preview)'}`,
          rest > 0 ? `\n…ещё ${rest} символов: papra_get(id: "${id}", offset: ${offset + part.length})` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'papra_preview',
      title: 'Посмотреть страницу документа',
      description:
        'Картинка страницы PDF или документа-картинки — когда распознанного текста нет или он плохой. rotate разворачивает только показ, файл не меняется. Прочитанный текст можно сохранить для поиска: papra_update с полем content.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: documentId,
        page: z.number().int().min(1).default(1).describe('Страница PDF, с 1'),
        rotate: angleInput.default(0).describe('Повернуть показ по часовой стрелке, градусы'),
      }),
      async run({ id, page, rotate }, { config }) {
        const pa = client(config)
        const doc = await pa.document(id)
        assertVisible(doc, config.excludeTag)
        if (!canPreview(doc.mimeType)) throw new ToolError(`Это ${doc.mimeType}: показать можно только PDF или картинку. Файл — через papra_link`)
        const { preview } = await import('./render')
        const shown = await preview(await download(pa, doc), doc.mimeType, page, rotate)
        const where = shown.pages ? `, страница ${page} из ${shown.pages}` : ''
        return { text: `${id} «${truncate(doc.name, 60)}»${where}`, images: [{ data: shown.data.toString('base64'), mimeType: shown.mimeType }] }
      },
    }),

    tool({
      name: 'papra_rotate',
      title: 'Повернуть файл документа',
      description:
        'Действительно повернуть файл, чтобы он был ровным в Papra и OCR прочитал его заново. Создаётся новый документ с новым id, название, дата, заметки и теги переносятся, старый уходит в корзину Papra; papra_undo это не откатит. Страницы PDF становятся картинками. Сначала посмотри через papra_preview с rotate и переспроси пользователя. Только с confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        id: documentId,
        angle: z.union([z.literal(90), z.literal(180), z.literal(270)]).describe('По часовой стрелке, градусы'),
        pages: z.array(z.number().int().min(1)).optional().describe('Какие страницы PDF повернуть; по умолчанию все'),
        drop_text: z.boolean().default(false).describe('true — PDF с текстовым слоем: заменить его заново распознанным'),
        confirm: z.boolean().default(false).describe('true — пользователь подтвердил'),
      }),
      async run({ id, angle, pages, drop_text, confirm }, { config }) {
        if (!confirm) throw new ToolError('Нужно confirm: true: документ получит новый id, старый уйдёт в корзину Papra. Сначала переспроси пользователя')
        const pa = client(config)
        const doc = await pa.document(id)
        assertVisible(doc, config.excludeTag)
        if (!canRotate(doc.mimeType)) throw new ToolError(`Это ${doc.mimeType}: повернуть можно только PDF, JPEG, PNG или WebP`)
        // Custom property values are not carried over and would quietly stay behind in the trash.
        if (doc.customProperties?.length) throw new ToolError('У документа есть свои свойства Papra, их перенести нельзя. Поверни файл вручную')
        const { rotateFile } = await import('./render')
        const rotated = await rotateFile(await download(pa, doc), doc.mimeType, angle, { pages, dropText: drop_text })

        const created = await pa.upload(rotated, doc.originalName || doc.name, doc.mimeType)
        // The old one goes only when the new one is complete: nothing is lost if a step fails.
        try {
          // The upload reply has no tags. They go separately below, the text comes from Papra's OCR.
          const patch = patchOf({ name: created.name, documentDate: created.documentDate ?? null, notes: created.notes ?? '', tags: [] }, { ...snapshot(doc), content: undefined })
          if (Object.keys(patch).length) await pa.update(created.id, patch)
          for (const t of doc.tags) await pa.addTag(created.id, t.id)
        } catch (e) {
          throw new ToolError(`Новый документ ${created.id} создан, но метаданные перенеслись не все; старый ${id} на месте. ${e instanceof Error ? e.message : String(e)}`)
        }
        try {
          await pa.trash(id)
        } catch (e) {
          throw new ToolError(`Новый документ ${created.id} готов, но старый ${id} не удалён, теперь их два. ${e instanceof Error ? e.message : String(e)}`)
        }
        return [`Повёрнуто на ${angle}°: «${truncate(doc.name, 60)}».`, `Новый id: ${created.id}. Старый ${id} — в корзине Papra.`, 'Текст появится, когда Papra закончит OCR, обычно через минуту.'].join('\n')
      },
    }),

    tool({
      name: 'papra_tags',
      title: 'Теги Papra',
      description: 'Все теги Papra с числом документов — чтобы размечать существующими, а не плодить дубли. Плюс правила разметки пользователя.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const tags = await client(config).tags()
        const list = [...tags]
          .sort((a, b) => (b.documentsCount ?? 0) - (a.documentsCount ?? 0))
          .slice(0, 300)
          .map((t) => `${t.name}${t.documentsCount !== undefined ? ` (${t.documentsCount})` : ''}${t.name.toLowerCase() === config.excludeTag.toLowerCase() ? ' — скрыт от ассистента' : ''}`)
          .join(', ')
        return [rulesBlock(config), `Теги: ${list || '—'}`].join('\n')
      },
    }),

    tool({
      name: 'papra_update',
      title: 'Разметить документы',
      description: 'Изменить метаданные одного или нескольких документов: название, дату, заметки, распознанный текст, теги (по именам; недостающие создаются). dry_run: true — только показать план. Изменения можно откатить через papra_undo.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        changes: z.array(changeInput).min(1).max(50),
        dry_run: z.boolean().default(false).describe('true — ничего не менять, показать, что будет'),
      }),
      async run({ changes, dry_run }, { config }) {
        const { pa, index } = await load(config)
        const batchId = newBatchId()
        const lines: string[] = []
        let applied = 0
        let recorded = false
        for (const change of changes) {
          let wrote = false
          try {
            const doc = await pa.document(change.id)
            assertVisible(doc, config.excludeTag)
            const before = snapshot(doc)
            const after: Snapshot = await plan(doc, change, index, pa, { dryRun: dry_run })
            if (!dry_run && hasChanges(before, after)) {
              try {
                await applyDiff(pa, change.id, before, after, () => {
                  wrote = true
                })
              } finally {
                // Recorded even after a partial failure, so what did go through can be rolled back.
                if (wrote) {
                  recordChange(batchId, change.id, before, after)
                  recorded = true
                }
              }
              applied++
            }
            lines.push(diffLine(change.id, before, after, index))
          } catch (e) {
            lines.push(`${change.id}: ${wrote ? 'изменён частично' : 'не изменён'} — ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        const head = dry_run ? `План для ${changes.length} ${plural(changes.length, ['документа', 'документов', 'документов'])} (ничего не изменено):` : `Обновлено ${applied} из ${changes.length}:`
        return [
          head,
          ...lines,
          index.created.length ? `${dry_run ? 'Будут созданы теги' : 'Созданы теги'}: ${index.created.map((n) => `«${n}»`).join(', ')}` : null,
          !dry_run && recorded ? `Откатить: papra_undo(batch: "${batchId}")` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'papra_undo',
      title: 'Откатить разметку',
      description: 'Вернуть метаданные документов, как было до пачки papra_update. Без batch — последняя пачка. Созданные теги остаются.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ batch: z.string().optional().describe('Id пачки из ответа papra_update') }),
      async run({ batch }, { config }) {
        const id = batch ?? lastBatchId()
        if (!id) return 'Откатывать нечего.'
        const rows = batchChanges(id)
        if (rows.length === 0) return `Пачка ${id} не найдена или уже откачена.`
        const { pa, index } = await load(config)
        const lines: string[] = []
        for (const row of rows) {
          const before = JSON.parse(row.beforeJson) as Snapshot
          try {
            const doc = await pa.document(row.documentId)
            assertVisible(doc, config.excludeTag)
            const current = snapshot(doc)
            await applyDiff(pa, row.documentId, current, before, () => {})
            markUndone(row.id)
            lines.push(diffLine(row.documentId, current, before, index))
          } catch (e) {
            lines.push(`${row.documentId}: не откачен — ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        return [`Откат пачки ${id}:`, ...lines].join('\n')
      },
    }),

    tool({
      name: 'papra_link',
      title: 'Ссылка на скачивание',
      description:
        'Ссылка на файл документа. По умолчанию личная: работает 24 часа и только в браузере, где пользователь вошёл в админку хаба. shareable: true — только если пользователь прямо попросил ссылку, чтобы переслать: открывается у любого, один раз, 15 минут.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        id: documentId,
        shareable: z.boolean().default(false).describe('true — пересылаемая одноразовая ссылка на 15 минут'),
      }),
      async run({ id, shareable }, { config }) {
        const doc = await client(config).document(id)
        assertVisible(doc, config.excludeTag)
        const { token } = createLink(id, { shareable })
        return [`«${truncate(doc.name, 70)}»:`, linkUrl(token), shareable ? LINK_KIND_TEXT.shareable : LINK_KIND_TEXT.personal].join('\n')
      },
    }),
  ],
})
