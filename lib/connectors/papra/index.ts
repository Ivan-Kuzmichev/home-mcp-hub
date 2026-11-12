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
import { t, tr } from '../../i18n'

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Address on the local network', placeholder: 'http://papra:1221' }),
    apiKey: secret({
      label: 'API key',
      help: 'Created in the Papra account settings. Permissions: documents:read, documents:update, tags:read, tags:create; organizations:read if the organization ID below is empty; documents:create and documents:delete to rotate files (papra_rotate). Needs Papra 26.5 or newer',
      section: 'connection',
    }),
    organizationId: field(
      z
        .string()
        .trim()
        .regex(/^org_[a-z0-9]+$/, { error: () => t`Needs an ID like org_… from the organization address in Papra` })
        .optional(),
      { label: 'Organization ID', placeholder: 'org_…', help: 'From the organization address in Papra. Empty — the user\'s only organization', mono: true, section: 'connection' },
    ),
    webUrl: field(
      z
        .string()
        .trim()
        .url({ error: () => t`Needs an address like https://papra.example.com` })
        .transform((v) => v.replace(/\/+$/, ''))
        .optional(),
      { label: 'Web interface address', placeholder: 'http://192.168.1.10:1221', help: 'For “open in Papra” links in replies; empty — no links', widget: 'url', mono: true, section: 'connection' },
    ),
    excludeTag: field(z.string().trim().default('private'), {
      label: 'Exclusion tag',
      help: 'The assistant does not search, read or change documents with this tag',
      placeholder: 'private',
      section: 'defaults',
    }),
    rules: field(z.string().trim().max(4000).optional(), {
      label: 'Labeling rules',
      help: 'Free text: the assistant reads it before every labeling pass',
      placeholder: '- tag “taxes” — income tax, returns, tax ID, deductions\n- title: “From whom — what it is — month year”\n- document date — the signing date, not the scan date',
      widget: 'textarea',
      section: 'defaults',
    }),
  })
  .superRefine((c, ctx) => {
    if (!c.apiKey) ctx.addIssue({ code: 'custom', path: ['apiKey'], message: t`API key required` })
  })

type Config = z.output<typeof configSchema>

const tool = toolFor<Config>()
const client = (c: Config) => new PaClient({ baseUrl: c.baseUrl, apiKey: c.apiKey, organizationId: c.organizationId })

async function load(c: Config) {
  const pa = client(c)
  return { pa, index: new TagIndex(await pa.tags()) }
}

function rulesBlock(c: Config): string {
  return c.rules ? t`Labeling rules (from the user):
${c.rules}
` : t`No labeling rules — stick to the existing tags and titles.
`
}

const angleInput = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])

// Mirrors render.ts, which is not imported up front: it pulls in the heavy libraries only when used.
const MAX_FILE_BYTES = 50 * 1024 * 1024
const canPreview = (mimeType: string) => mimeType === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(mimeType)
const canRotate = (mimeType: string) => mimeType === 'application/pdf' || /^image\/(png|jpeg|webp)$/.test(mimeType)

async function download(pa: PaClient, doc: PaDocument): Promise<Buffer> {
  const tooBig = () => new ToolError(t`The file is over 50 MB, not processing it here. Download it with papra_link`)
  if ((doc.originalSize ?? 0) > MAX_FILE_BYTES) throw tooBig()
  const data = Buffer.from(await (await pa.file(doc.id)).arrayBuffer())
  if (data.length > MAX_FILE_BYTES) throw tooBig()
  return data
}

const documentId = z.string().regex(/^doc_[a-z0-9]+$/, { error: () => t`Needs an id like doc_…` }).describe('document id, doc_…')

const filterInput = {
  query: z.string().max(900).optional().describe('Search in titles and content. Understands the Papra syntax: name:invoice, content:"rental agreement", OR, NOT'),
  tags: z.array(z.string()).optional().describe('All of these tags (by name)'),
  added_after: z.string().optional().describe('Added to Papra on or after, YYYY-MM-DD'),
  added_before: z.string().optional().describe('Added on or before, YYYY-MM-DD'),
  date_after: z.string().optional().describe('Document date on or after, YYYY-MM-DD'),
  date_before: z.string().optional().describe('Document date on or before, YYYY-MM-DD'),
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
  name: z.string().max(255).optional().describe('Title'),
  date: z.string().nullable().optional().describe('Document date, YYYY-MM-DD; null — remove'),
  notes: z.string().max(2048).optional().describe('Notes; an empty string — remove'),
  content: z.string().max(500_000).optional().describe('Replace the OCR text: what you read on the scan via papra_preview. Search works on it'),
  tags: z.array(z.string().max(64)).optional().describe('Replace the tags with this list'),
  add_tags: z.array(z.string().max(64)).optional().describe('Add tags (new ones are created)'),
  remove_tags: z.array(z.string()).optional(),
})

export const papra = defineConnector<Config>({
  id: 'papra',
  name: 'Papra',
  description: 'Document archive (Papra)',
  docsUrl: 'https://docs.papra.app/resources/api-endpoints/',
  configSchema,

  instructions(c, { tools }) {
    const has = (t: string) => tools.includes(t)
    if (!tools.some((t) => t.startsWith('papra_'))) return null
    const lines: string[] = []
    if (has('papra_update')) {
      lines.push(
        [
          t`Papra: to label — ${has('papra_review') ? t`papra_review, then ` : ''}papra_update with a list of changes.`,
          has('papra_tags') ? t`Use the existing tags from papra_tags.` : null,
          t`For a bulk change show the plan first (dry_run) unless the user asked to apply right away.`,
          // The rules themselves stay out of the always-loaded text: they arrive with the reads.
          c.rules ? t`The user has labeling rules — they come in the papra_review, papra_get and papra_tags replies; read them before any change.` : null,
        ]
          .filter(Boolean)
          .join(' '),
      )
    } else {
      lines.push(t`Papra: documents can be searched and read; metadata cannot be changed.`)
    }
    if (has('papra_link')) lines.push(t`A shareable Papra document link — only on a direct request.`)
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
      if (first && !('notes' in first)) return { ok: false, summary: t`Needs Papra 26.5 or newer: this version cannot search through the document list`, details: [] }
      return {
        ok: true,
        summary: `${count} ${plural(count, ['document', 'documents'])}`,
        details: [org.name ? t`Organization “${org.name}”` : null, `${tags.length} ${plural(tags.length, ['tag', 'tags'])}`, t`response ${Date.now() - started} ms`].filter((d): d is string => !!d),
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'papra_search',
      title: 'Papra search',
      description: 'Search Papra documents by title and content, tags and dates. Returns the id, title, date and tags.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ ...filterInput, limit: z.number().int().min(1).max(25).default(10), page: z.number().int().min(1).default(1) }),
      async run(args, { config }) {
        const { pa, index } = await load(config)
        const data = await pa.documents({ searchQuery: searchQuery(toFilter(args), index, config.excludeTag), pageSize: args.limit, pageIndex: args.page - 1 })
        const docs = data.documents.filter((d) => isVisible(d, config.excludeTag))
        if (docs.length === 0) return t`Nothing found.`
        const pages = Math.ceil(data.count / args.limit)
        const head = t`Found ${data.count} ${plural(data.count, ['document', 'documents'])}${pages > 1 ? t`, page ${args.page} of ${pages}` : ''}:`
        return [head, ...docs.map(docLine)].join('\n')
      },
    }),

    tool({
      name: 'papra_review',
      title: 'Documents to label',
      description:
        'A batch of documents to label: current metadata, the start of the OCR text and how recent documents were labeled. By default the unlabeled ones (no tags or no date). Then papra_update with a list of changes.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        ...filterInput,
        scope: z.enum(['unlabeled', 'untagged', 'all']).default('unlabeled').describe('unlabeled — no tags or no date; untagged — no tags; all — everything that matches the filter'),
        limit: z.number().int().min(1).max(20).default(20),
      }),
      async run(args, { config }) {
        const { pa, index } = await load(config)
        const data = await pa.documents({ searchQuery: searchQuery(toFilter(args), index, config.excludeTag, args.scope), pageSize: args.limit })
        const brief = data.documents.filter((d) => isVisible(d, config.excludeTag))
        if (brief.length === 0) return t`${rulesBlock(config)}
No documents to label.`

        const full = await mapLimit(brief, 5, (d) => pa.document(d.id))

        // Papra has no classifier suggestions: recent labeled documents are the consistency hint.
        const batchIds = new Set(full.map((d) => d.id))
        const recent = await pa.documents({ searchQuery: searchQuery({ query: 'has:tags' }, index, config.excludeTag), pageSize: 10 })
        const examples = recent.documents
          .filter((d) => !batchIds.has(d.id) && isVisible(d, config.excludeTag))
          .slice(0, 5)
          .map((d) => `  «${truncate(d.name, 60)}» · ${day(d.documentDate)} · [${d.tags.map((t) => t.name).join(', ')}]`)

        const blocks = full.map((doc) =>
          [`${headLine(doc)}`, t`Now: ${metaLine(doc)}`, t`Text: ${truncate((doc.content ?? '').replace(/\s+/g, ' ').trim() || t`(empty — no OCR text, look at papra_preview)`, 800)}`].join('\n'),
        )
        return [
          rulesBlock(config),
          t`Documents to label: ${data.count}, in this batch ${full.length}.${data.count > full.length ? t` The rest — in the next call after labeling these.` : ''}`,
          '',
          blocks.join('\n\n'),
          examples.length ? t`
How recent documents were labeled:
${examples.join('\n')}` : '',
          t`
Tags — papra_tags. Apply — papra_update (dry_run: true shows the plan).`,
        ].join('\n')
      },
    }),

    tool({
      name: 'papra_get',
      title: 'Papra document',
      description: 'Document metadata and the full OCR text (a long one in parts via offset).',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: documentId,
        offset: z.number().int().min(0).default(0).describe('Start from this character of the text'),
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
          org ? t`Open in Papra: ${config.webUrl}/organizations/${org.id}/documents/${id}` : null,
          t`
Text (${offset}–${offset + part.length} of ${text.length}):
${part || t`(no OCR text — look at papra_preview)`}`,
          rest > 0 ? t`
…${rest} more characters: papra_get(id: "${id}", offset: ${offset + part.length})` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'papra_preview',
      title: 'View a document page',
      description:
        'An image of a PDF page or of an image document — when there is no OCR text or it is bad. rotate turns only the view, the file does not change. Text you read can be saved for search: papra_update with the content field.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: documentId,
        page: z.number().int().min(1).default(1).describe('PDF page, from 1'),
        rotate: angleInput.default(0).describe('Turn the view clockwise, degrees'),
      }),
      async run({ id, page, rotate }, { config }) {
        const pa = client(config)
        const doc = await pa.document(id)
        assertVisible(doc, config.excludeTag)
        if (!canPreview(doc.mimeType)) throw new ToolError(t`This is ${doc.mimeType}: only a PDF or an image can be shown. The file — via papra_link`)
        const { preview } = await import('./render')
        const shown = await preview(await download(pa, doc), doc.mimeType, page, rotate)
        const where = shown.pages ? t`, page ${page} of ${shown.pages}` : ''
        return { text: `${id} «${truncate(doc.name, 60)}»${where}`, images: [{ data: shown.data.toString('base64'), mimeType: shown.mimeType }] }
      },
    }),

    tool({
      name: 'papra_rotate',
      title: 'Rotate the document file',
      description:
        'Really rotate the file so it is upright in Papra and the OCR reads it again. A new document with a new id is created, the title, date, notes and tags move over, the old one goes to the Papra trash; papra_undo cannot undo this. PDF pages become images. Look with papra_preview and rotate first and ask the user. Only with confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        id: documentId,
        angle: z.union([z.literal(90), z.literal(180), z.literal(270)]).describe('Clockwise, degrees'),
        pages: z.array(z.number().int().min(1)).optional().describe('Which PDF pages to rotate; all by default'),
        drop_text: z.boolean().default(false).describe('true — a PDF with a text layer: replace it with a fresh OCR'),
        confirm: z.boolean().default(false).describe('true — the user confirmed'),
      }),
      async run({ id, angle, pages, drop_text, confirm }, { config }) {
        if (!confirm) throw new ToolError(t`confirm: true is required: the document gets a new id, the old one goes to the Papra trash. Ask the user first`)
        const pa = client(config)
        const doc = await pa.document(id)
        assertVisible(doc, config.excludeTag)
        if (!canRotate(doc.mimeType)) throw new ToolError(t`This is ${doc.mimeType}: only PDF, JPEG, PNG or WebP can be rotated`)
        // Custom property values are not carried over and would quietly stay behind in the trash.
        if (doc.customProperties?.length) throw new ToolError(t`The document has Papra custom properties, they cannot be moved over. Rotate the file by hand`)
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
          throw new ToolError(t`New document ${created.id} was created, but not all metadata moved over; the old ${id} is still there. ${e instanceof Error ? e.message : String(e)}`)
        }
        try {
          await pa.trash(id)
        } catch (e) {
          throw new ToolError(t`New document ${created.id} is ready, but the old ${id} was not deleted, now there are two. ${e instanceof Error ? e.message : String(e)}`)
        }
        return [t`Rotated by ${angle}°: “${truncate(doc.name, 60)}”.`, t`New id: ${created.id}. The old ${id} is in the Papra trash.`, t`The text appears when Papra finishes the OCR, usually in a minute.`].join('\n')
      },
    }),

    tool({
      name: 'papra_tags',
      title: 'Papra tags',
      description: 'All Papra tags with document counts — to label with existing ones instead of making duplicates. Plus the user\'s labeling rules.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const tags = await client(config).tags()
        const list = [...tags]
          .sort((a, b) => (b.documentsCount ?? 0) - (a.documentsCount ?? 0))
          .slice(0, 300)
          .map((item) => `${item.name}${item.documentsCount !== undefined ? ` (${item.documentsCount})` : ''}${item.name.toLowerCase() === config.excludeTag.toLowerCase() ? t` — hidden from the assistant` : ''}`)
          .join(', ')
        return [rulesBlock(config), t`Tags: ${list || '—'}`].join('\n')
      },
    }),

    tool({
      name: 'papra_update',
      title: 'Label documents',
      description: 'Change the metadata of one or more documents: title, date, notes, OCR text, tags (by name; missing ones are created). dry_run: true — only show the plan. Changes can be undone with papra_undo.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        changes: z.array(changeInput).min(1).max(50),
        dry_run: z.boolean().default(false).describe('true — change nothing, show what would happen'),
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
            lines.push(`${change.id}: ${wrote ? t`partly changed` : t`not changed`} — ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        const head = dry_run ? t`Plan for ${changes.length} ${plural(changes.length, ['document', 'documents'], 'genitive')} (nothing changed):` : t`Updated ${applied} of ${changes.length}:`
        return [
          head,
          ...lines,
          index.created.length ? `${dry_run ? t`Tags to be created` : t`Tags created`}: ${index.created.map((n) => `«${n}»`).join(', ')}` : null,
          !dry_run && recorded ? t`Undo: papra_undo(batch: "${batchId}")` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'papra_undo',
      title: 'Undo labeling',
      description: 'Restore document metadata to what it was before a papra_update batch. Without batch — the last batch. Created tags stay.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ batch: z.string().optional().describe('Batch id from the papra_update reply') }),
      async run({ batch }, { config }) {
        const id = batch ?? lastBatchId()
        if (!id) return t`Nothing to undo.`
        const rows = batchChanges(id)
        if (rows.length === 0) return t`Batch ${id} not found or already undone.`
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
            lines.push(t`${row.documentId}: not undone — ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        return [t`Undo of batch ${id}:`, ...lines].join('\n')
      },
    }),

    tool({
      name: 'papra_link',
      title: 'Download link',
      description:
        'A link to the document file. Personal by default: works for 24 hours and only in a browser signed in to the hub admin panel. shareable: true — only when the user directly asked for a link to forward: opens for anyone, once, within 15 minutes.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        id: documentId,
        shareable: z.boolean().default(false).describe('true — a shareable one-time link for 15 minutes'),
      }),
      async run({ id, shareable }, { config }) {
        const doc = await client(config).document(id)
        assertVisible(doc, config.excludeTag)
        const { token } = createLink(id, { shareable })
        return [`«${truncate(doc.name, 70)}»:`, linkUrl(token), shareable ? tr(LINK_KIND_TEXT.shareable) : tr(LINK_KIND_TEXT.personal)].join('\n')
      },
    }),
  ],
})
