import { z } from 'zod'
import { plural, truncate } from '../format'
import { mapLimit } from '../map-limit'
import { baseUrl, defineConnector, field, secret, toolFor, ToolError } from '../types'
import { LINK_KIND_TEXT, linkUrl } from '../../download-links'
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
import { t, tr } from '../../i18n'

const configSchema = z
  .object({
    baseUrl: baseUrl({ label: 'Address on the local network', placeholder: 'http://paperless:8000' }),
    apiToken: secret({
      label: 'API token',
      help: 'Better a separate Paperless user: view and change documents, tags, correspondents and types. The token is in the user profile',
      section: 'connection',
    }),
    webUrl: field(
      z
        .string()
        .trim()
        .url({ error: () => t`Needs an address like https://paperless.example.com` })
        .transform((v) => v.replace(/\/+$/, ''))
        .optional(),
      { label: 'Web interface address', placeholder: 'http://192.168.1.10:8000', help: 'For “open in Paperless” links in replies; empty — no links', widget: 'url', mono: true, section: 'connection' },
    ),
    excludeTag: field(z.string().trim().default('private'), {
      label: 'Exclusion tag',
      help: 'The assistant does not search, read or change documents with this tag',
      placeholder: 'private',
      section: 'defaults',
    }),
    removeInbox: field(z.boolean().default(true), {
      label: 'Remove the inbox tag after labeling',
      help: 'Paperless inbox tags are removed when the assistant labels a document',
      widget: 'switch',
      section: 'defaults',
    }),
    rules: field(z.string().trim().max(4000).optional(), {
      label: 'Labeling rules',
      help: 'Free text: the assistant reads it before every labeling pass',
      placeholder:
        '- tag “taxes” — income tax, returns, tax ID, deductions\n- title: “Correspondent — what it is — month year”\n- document date — the signing date, not the scan date',
      widget: 'textarea',
      section: 'defaults',
    }),
  })
  .superRefine((c, ctx) => {
    if (!c.apiToken) ctx.addIssue({ code: 'custom', path: ['apiToken'], message: t`API token required` })
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
  return c.rules ? t`Labeling rules (from the user):
${c.rules}
` : t`No labeling rules — stick to the existing tags and titles.
`
}

const filterInput = {
  query: z.string().optional().describe('Full-text search in the content'),
  tags: z.array(z.string()).optional().describe('All of these tags (by name)'),
  correspondent: z.string().optional().describe('Correspondent (by name)'),
  document_type: z.string().optional().describe('Document type (by name)'),
  added_after: z.string().optional().describe('Added to Paperless on or after, YYYY-MM-DD'),
  added_before: z.string().optional().describe('Added on or before, YYYY-MM-DD'),
  created_after: z.string().optional().describe('Document date on or after, YYYY-MM-DD'),
  created_before: z.string().optional().describe('Document date on or before, YYYY-MM-DD'),
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
  id: z.number().int().describe('document id'),
  title: z.string().optional(),
  created: z.string().optional().describe('Document date, YYYY-MM-DD'),
  correspondent: z.string().nullable().optional().describe('Correspondent name; a new one is created; null — remove'),
  document_type: z.string().nullable().optional().describe('Type name; a new one is created; null — remove'),
  tags: z.array(z.string()).optional().describe('Replace the tags with this list'),
  add_tags: z.array(z.string()).optional().describe('Add tags (new ones are created)'),
  remove_tags: z.array(z.string()).optional(),
  keep_inbox: z.boolean().optional().describe('Keep the inbox tag'),
})

export const paperless = defineConnector<Config>({
  id: 'paperless',
  name: 'Paperless',
  description: 'Document archive (paperless-ngx)',
  docsUrl: 'https://docs.paperless-ngx.com/api/',
  configSchema,

  instructions(c, { tools }) {
    const has = (t: string) => tools.includes(t)
    if (!tools.some((t) => t.startsWith('paperless_'))) return null
    const lines: string[] = []
    if (has('paperless_update')) {
      lines.push(
        [
          t`Paperless: to label — ${has('paperless_review') ? t`paperless_review (it has examples of past labeling), then ` : ''}paperless_update with a list of changes.`,
          has('paperless_taxonomy') ? t`Use the existing tags and correspondents from paperless_taxonomy.` : null,
          t`For a bulk change show the plan first (dry_run) unless the user asked to apply right away.`,
          // The rules themselves stay out of the always-loaded text: they arrive with the reads.
          c.rules ? t`The user has labeling rules — they come in the paperless_review, paperless_get and paperless_taxonomy replies; read them before any change.` : null,
        ]
          .filter(Boolean)
          .join(' '),
      )
    } else {
      lines.push(t`Paperless: documents can be searched and read; metadata cannot be changed.`)
    }
    if (has('paperless_link')) lines.push(t`A shareable document link — only on a direct request.`)
    return lines.join('\n')
  },

  async test(c) {
    const started = Date.now()
    try {
      const pl = client(c)
      const [info, tax] = await Promise.all([pl.ping(), pl.taxonomy()])
      return {
        ok: true,
        version: info.version ?? undefined,
        summary: `${info.documents} ${plural(info.documents, ['document', 'documents'])}`,
        details: [
          info.version ? `Paperless ${info.version}` : null,
          `${tax.tags.length} ${plural(tax.tags.length, ['tag', 'tags'])}`,
          t`response ${Date.now() - started} ms`,
        ].filter((d): d is string => !!d),
      }
    } catch (e) {
      return { ok: false, summary: e instanceof Error ? e.message : String(e), details: [] }
    }
  },

  tools: [
    tool({
      name: 'paperless_search',
      title: 'Paperless search',
      description: 'Search Paperless documents by content (full text), tags, correspondent, type and dates. Returns the id, title, date and metadata.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ ...filterInput, limit: z.number().int().min(1).max(25).default(10), page: z.number().int().min(1).default(1) }),
      async run(args, { config }) {
        const { pl, index, excludedId } = await load(config)
        const data = await pl.documents({ ...filterParams(toFilter(args), index, excludedId), page_size: args.limit, page: args.page })
        if (data.count === 0) return t`Nothing found.`
        const pages = Math.ceil(data.count / args.limit)
        const head = t`Found ${data.count} ${plural(data.count, ['document', 'documents'])}${pages > 1 ? t`, page ${args.page} of ${pages}` : ''}:`
        return [head, ...data.results.map((d) => docLine(d, index))].join('\n')
      },
    }),

    tool({
      name: 'paperless_review',
      title: 'Documents to label',
      description:
        'A batch of documents to label: current metadata, the start of the OCR text, the Paperless classifier suggestions and how past documents of the same correspondent were labeled. By default the unlabeled ones (inbox tag, no correspondent or no type). Then paperless_update with a list of changes.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        ...filterInput,
        scope: z.enum(['unlabeled', 'inbox', 'all']).default('unlabeled').describe('unlabeled — not labeled yet; inbox — only with the inbox tag; all — everything that matches the filter'),
        limit: z.number().int().min(1).max(20).default(20),
      }),
      async run(args, { config }) {
        const { pl, index, excludedId } = await load(config)
        const { total, docs: brief } = await reviewDocuments(pl, filterParams(toFilter(args), index, excludedId), args.scope, index, args.limit)
        if (brief.length === 0) return t`${rulesBlock(config)}
No documents to label.`

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
            t`#${doc.id} · added ${day(doc.added)}${doc.original_file_name ? t` · file ${doc.original_file_name}` : ''}`,
            t`Now: ${metaLine(doc, index)}`,
            suggestionLine(sug, index),
            t`Text: ${truncate((doc.content ?? '').replace(/\s+/g, ' ').trim() || t`(empty — no OCR text, look at paperless_thumbnail)`, 800)}`,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        const shownExamples = examples.filter(Boolean)
        return [
          rulesBlock(config),
          t`Documents to label: ${total}, in this batch ${full.length}.${total > full.length ? t` The rest — in the next call after labeling these.` : ''}`,
          '',
          blocks.join('\n\n'),
          shownExamples.length ? t`
How past documents were labeled:
${shownExamples.join('\n')}` : '',
          t`
Tags/correspondents/types — paperless_taxonomy. Apply — paperless_update (dry_run: true shows the plan).`,
        ].join('\n')
      },
    }),

    tool({
      name: 'paperless_get',
      title: 'Paperless document',
      description: 'Document metadata, classifier suggestions and the full OCR text (a long one in parts via offset).',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        id: z.number().int(),
        offset: z.number().int().min(0).default(0).describe('Start from this character of the text'),
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
          config.rules ? rulesBlock(config) : null,
          t`#${doc.id} · added ${day(doc.added)}${doc.original_file_name ? t` · file ${doc.original_file_name}` : ''}`,
          metaLine(doc, index),
          suggestionLine(sug, index),
          webLink(config, id) ? t`Open in Paperless: ${webLink(config, id)}` : null,
          t`
Text (${offset}–${offset + part.length} of ${text.length}):
${part || t`(no OCR text — look at paperless_thumbnail)`}`,
          rest > 0 ? t`
…${rest} more characters: paperless_get(id: ${id}, offset: ${offset + part.length})` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'paperless_thumbnail',
      title: 'Document thumbnail',
      description: 'An image of the first page — when there is no OCR text or it is bad (a receipt photo, handwriting). Small text may be unreadable on the thumbnail.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ id: z.number().int() }),
      async run({ id }, { config }) {
        const { pl, excludedId } = await load(config)
        const doc = await pl.document(id)
        assertVisible(doc, excludedId, config.excludeTag)
        const thumb = await pl.thumbnail(id)
        if (thumb.data.length > 2 * 1024 * 1024) throw new ToolError(t`The thumbnail is over 2 MB — not sending it`)
        return { text: t`Thumbnail #${id} “${truncate(doc.title, 60)}”`, images: [{ data: thumb.data.toString('base64'), mimeType: thumb.mimeType }] }
      },
    }),

    tool({
      name: 'paperless_taxonomy',
      title: 'Tags, correspondents and types',
      description: 'All Paperless tags, correspondents and document types with document counts — to label with existing ones instead of making duplicates. Plus the user\'s labeling rules.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({}),
      async run(_args, { config }) {
        const { pl } = await load(config)
        const tax = await pl.taxonomy()
        const list = (items: { name: string; document_count?: number; is_inbox_tag?: boolean }[]) =>
          [...items]
            .sort((a, b) => (b.document_count ?? 0) - (a.document_count ?? 0))
            .slice(0, 300)
            .map((i) => `${i.name}${i.document_count !== undefined ? ` (${i.document_count})` : ''}${i.is_inbox_tag ? t` — inbox` : ''}${i.name === config.excludeTag ? t` — hidden from the assistant` : ''}`)
            .join(', ')
        return [
          rulesBlock(config),
          t`Tags: ${list(tax.tags) || '—'}`,
          t`Correspondents: ${list(tax.correspondents) || '—'}`,
          t`Types: ${list(tax.documentTypes) || '—'}`,
        ].join('\n')
      },
    }),

    tool({
      name: 'paperless_update',
      title: 'Label documents',
      description:
        'Change the metadata of one or more documents: title, date, correspondent, type, tags (by name; missing ones are created). The inbox tag is removed. dry_run: true — only show the plan. Changes can be undone with paperless_undo.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        changes: z.array(changeInput).min(1).max(50),
        dry_run: z.boolean().default(false).describe('true — change nothing, show what would happen'),
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
            lines.push(t`#${change.id}: not changed — ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        const created = index.created.map((c) => `${tr(KIND_LABELS[c.kind])} «${c.name}»`)
        const head = dry_run ? t`Plan for ${changes.length} ${plural(changes.length, ['document', 'documents'], 'genitive')} (nothing changed):` : t`Updated ${applied} of ${changes.length}:`
        return [
          head,
          ...lines,
          created.length ? `${dry_run ? t`Will be created` : t`Created`}: ${created.join(', ')}` : null,
          !dry_run && applied ? t`Undo: paperless_undo(batch: "${batchId}")` : null,
        ]
          .filter(Boolean)
          .join('\n')
      },
    }),

    tool({
      name: 'paperless_undo',
      title: 'Undo labeling',
      description: 'Restore document metadata to what it was before a paperless_update batch. Without batch — the last batch. Created tags and correspondents stay.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ batch: z.string().optional().describe('Batch id from the paperless_update reply') }),
      async run({ batch }, { config }) {
        const id = batch ?? lastBatchId()
        if (!id) return t`Nothing to undo.`
        const rows = batchChanges(id)
        if (rows.length === 0) return t`Batch ${id} not found or already undone.`
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
            lines.push(t`#${row.documentId}: not undone — ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        return [t`Undo of batch ${id}:`, ...lines].join('\n')
      },
    }),

    tool({
      name: 'paperless_link',
      title: 'Download link',
      description:
        'A link to the document file (archived PDF or original). Personal by default: works for 24 hours and only in a browser signed in to the hub admin panel. shareable: true — only when the user directly asked for a link to forward: opens for anyone, once, within 15 minutes.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        id: z.number().int(),
        original: z.boolean().default(false).describe('true — the original file, false — the archived PDF'),
        shareable: z.boolean().default(false).describe('true — a shareable one-time link for 15 minutes'),
      }),
      async run({ id, original, shareable }, { config }) {
        const { pl, excludedId } = await load(config)
        const doc = await pl.document(id)
        assertVisible(doc, excludedId, config.excludeTag)
        const { token } = createLink(id, { original, shareable })
        const what = original ? t`original` : t`archived PDF`
        return [
          `«${truncate(doc.title, 70)}» — ${what}:`,
          linkUrl(token),
          shareable ? LINK_KIND_TEXT.shareable : LINK_KIND_TEXT.personal,
        ].join('\n')
      },
    }),
  ],
})
