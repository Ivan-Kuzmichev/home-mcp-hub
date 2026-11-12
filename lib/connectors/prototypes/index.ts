import { z } from 'zod'
import { localeTag, t, tr } from '../../i18n'
import {
  appendDraft,
  commitDraft,
  draftSize,
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
  startDraft,
  totalSize,
  update,
  type Expiry,
  type Prototype,
} from '../../prototypes/store'
import { clearData, dataSize, MAX_DATA_BYTES, readData } from '../../prototypes/data'
import { formatSize, plural, truncate } from '../format'
import { defineConnector, toolFor, ToolError } from '../types'

const configSchema = z.object({})
type Config = z.output<typeof configSchema>
const tool = toolFor<Config>()

/** «12 нояб» in Russian (without the dot), «Nov 12» in English. */
const dayMonth = (d: Date) => new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'short' }).format(d).replace('.', '')

export function expiryText(p: Pick<Prototype, 'expiresAt'>): string {
  if (!p.expiresAt) return t`no expiry`
  return isExpired(p) ? t`expired ${dayMonth(p.expiresAt)}` : t`until ${dayMonth(p.expiresAt)}`
}

const expiresInput = z.enum(['never', '7d', '30d']).describe('Lifetime: never — no expiry, 7d or 30d')
const pinInput = z.string().regex(PIN_PATTERN, { error: () => t`The PIN is 4 to 8 digits` }).describe('A 4–8 digit PIN to view it')
const refInput = z.string().min(1).describe('Slug or prototype link from prototype_list')
const moreInput = z
  .boolean()
  .default(false)
  .describe('true — this is not the last part of the HTML: add the rest with prototype_append, the last part with more: false')

// Measured: one tool argument breaks at ~10 KB of generated HTML on Claude's side, 5–6 KB parts go through.
export const DATA_HINT =
  'Storage: the page already has window.hub.db — a JSON document of this prototype shared by all visitors (up to 50 MB, {} by default; get/set pass it whole — keep text and lists, not images). await hub.db.get(); await hub.db.set(obj) — overwrite it whole; await hub.db.update(d => { d.items.push(x); return d }) — an edit that keeps other people\'s changes. localStorage is not available in the sandbox — use hub.db.'

export const CHUNK_HINT = 'Send HTML over ~5 KB in parts of 4–5 KB: the first part with more: true, the rest with prototype_append, the last one with more: false.'

function find(ref: string): Prototype {
  const p = getBySlug(slugFrom(ref))
  if (!p) throw new ToolError(t`Prototype “${ref}” not found — check prototype_list`)
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
  name: 'Prototypes',
  description: 'HTML page hosting by link',
  builtin: true,
  configSchema,

  instructions(_c, { tools }) {
    if (!['prototype_publish', 'prototype_update'].some((t) => tools.includes(t))) return null
    // The chunk hint names prototype_append: without it, big pages cannot be sent at all.
    return tools.includes('prototype_append')
      ? t`Prototypes: ${tr(CHUNK_HINT)} One big call with the whole HTML may break.`
      : t`Prototypes: HTML over ~5 KB in one call may break, and appending in parts is off — warn the user.`
  },

  async test() {
    const list = listPrototypes()
    return {
      ok: true,
      summary: `${list.length} ${plural(list.length, ['prototype', 'prototypes'])}`,
      details: [t`${formatSize(totalSize())} on disk`],
    }
  },

  tools: [
    tool({
      name: 'prototype_publish',
      title: 'Publish prototype',
      description:
        `Publish self-contained HTML (styles and scripts inside, images as data URIs, CDNs allowed) and get a public link. The page opens without signing in; with a PIN — only by the PIN. ${DATA_HINT} ${CHUNK_HINT}`,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe('Title — shown on the PIN page and in the admin panel'),
        html: z.string().min(1).describe('A complete HTML document'),
        pin: pinInput.optional(),
        expires: expiresInput.default('never'),
        more: moreInput,
      }),
      async run({ title, html, pin, expires, more }) {
        const p = await guard(() => publish({ title, html, pin, expiry: expires as Expiry, maxBytes: MAX_TOOL_HTML_BYTES, draft: more }))
        if (more) return t`Draft “${p.title}” created, ${formatSize(Buffer.byteLength(html))} received. Slug: ${p.slug}
Add the rest with prototype_append(prototype: "${p.slug}"), the last part with more: false.`
        return [t`Published: “${p.title}”`, publicUrl(p.slug), `${pin ? t`PIN set` : t`No PIN`} · ${expiryText(p)} · ${formatSize(p.sizeBytes)}`].join('\n')
      },
    }),

    tool({
      name: 'prototype_update',
      title: 'Update prototype',
      description: `Replace the HTML, title, PIN or lifetime of a prototype. The link stays. A new PIN resets access for everyone who entered the old one. Large HTML in parts: ${CHUNK_HINT}`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        prototype: refInput,
        html: z.string().min(1).optional().describe('New complete HTML'),
        title: z.string().min(1).max(200).optional(),
        pin: pinInput.optional().describe('New PIN'),
        remove_pin: z.boolean().optional().describe('true — open without a PIN'),
        expires: expiresInput.optional().describe('New lifetime, counted from today'),
        more: moreInput,
      }),
      async run(args) {
        const p = find(args.prototype)
        if (args.pin && args.remove_pin) throw new ToolError(t`Either pin or remove_pin`)
        const pin = args.remove_pin ? null : args.pin
        if (args.html === undefined && args.title === undefined && pin === undefined && args.expires === undefined) throw new ToolError(t`Nothing to change`)
        if (args.more && args.html === undefined) throw new ToolError(t`more: true makes sense only with html`)
        // Chunked update: the new HTML starts as a draft, the current version stays online.
        const html = args.more ? undefined : args.html
        if (args.more) await guard(async () => startDraft(p, args.html!))
        const next = await guard(() => update(p, { html, title: args.title, pin, expiry: args.expires as Expiry | undefined, maxBytes: MAX_TOOL_HTML_BYTES }))
        if (args.more) {
          return t`Started a new version of “${next.title}”, ${formatSize(Buffer.byteLength(args.html!))} received. The current version stays for now.
Add the rest with prototype_append(prototype: "${next.slug}"), the last part with more: false.`
        }
        const changes = [
          args.html !== undefined && `HTML → v${next.version}`,
          args.title !== undefined && t`title`,
          pin === null && t`PIN removed`,
          typeof pin === 'string' && t`PIN changed`,
          args.expires !== undefined && t`lifetime: ${expiryText(next)}`,
        ].filter(Boolean)
        return [t`Updated “${next.title}”: ${changes.join(', ')}`, publicUrl(next.slug)].join('\n')
      },
    }),

    tool({
      name: 'prototype_append',
      title: 'Append to prototype',
      description:
        'Add the next HTML part to a draft started by prototype_publish or prototype_update with more: true. Parts are joined as is. The last part with more: false: then the page is published whole.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        prototype: refInput,
        html: z.string().min(1).describe('The next HTML part'),
        more: moreInput,
      }),
      async run({ prototype: ref, html, more }) {
        const p = find(ref)
        const total = await guard(async () => appendDraft(p, html))
        if (more) return t`Received, the draft has ${formatSize(total)}. Continue with prototype_append; the last part with more: false.`
        const next = await guard(() => commitDraft(p))
        const verb = p.version === 0 ? t`Published` : t`Updated to v${next.version}`
        return [`${verb}: «${next.title}»`, publicUrl(next.slug), `${next.pinHash ? t`PIN set` : t`No PIN`} · ${expiryText(next)} · ${formatSize(next.sizeBytes)}`].join('\n')
      },
    }),

    tool({
      name: 'prototype_list',
      title: 'Prototype list',
      description: 'Published prototypes: link, PIN, views, lifetime, update date.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      async run({ limit }) {
        const list = listPrototypes()
        if (list.length === 0) return t`No prototypes yet.`
        const lines = list.slice(0, limit).map((p) => {
          const draft = draftSize(p)
          if (p.version === 0) return t`• “${truncate(p.title, 60)}” — slug ${p.slug} · uploading in parts${draft !== null ? t`, ${formatSize(draft)} received` : ''}`
          const parts = [p.pinHash ? t`PIN` : t`open`, ...(draft !== null ? [t`a new version is uploading (${formatSize(draft)})`] : []), `${p.views} ${plural(p.views, ['view', 'views'])}`, expiryText(p), t`updated ${p.updatedAt.toISOString().slice(0, 10)}`]
          return `• «${truncate(p.title, 60)}» — ${publicUrl(p.slug)} · ${parts.join(' · ')}`
        })
        return [`${list.length} ${plural(list.length, ['prototype', 'prototypes'])}:`, ...lines].join('\n')
      },
    }),

    tool({
      name: 'prototype_data',
      title: 'Prototype data',
      description: 'Show the JSON from the prototype storage (window.hub.db) or clear it. Clearing cannot be undone: ask the user first and pass clear: true, confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        prototype: refInput,
        clear: z.boolean().optional().describe('true — erase all data'),
        confirm: z.boolean().optional().describe('true — the user confirmed clearing'),
      }),
      async run({ prototype: ref, clear, confirm }) {
        const p = find(ref)
        const size = dataSize(p)
        if (clear) {
          if (size === null) return t`“${p.title}” has no data.`
          if (confirm !== true) return t`Not cleared. Ask the user and repeat with confirm: true.
The data of “${p.title}” (${formatSize(size)}) will be erased.`
          clearData(p)
          return t`The data of “${p.title}” is erased.`
        }
        if (size === null) return t`“${p.title}” has no data yet.`
        const { rev, data } = readData(p)
        return [t`“${p.title}”: ${formatSize(size)} of ${formatSize(MAX_DATA_BYTES)}, saves: ${rev}`, truncate(JSON.stringify(data, null, 1), 3000)].join('\n')
      },
    }),

    tool({
      name: 'prototype_delete',
      title: 'Delete prototype',
      description: 'Delete a prototype with all versions; the link stops working. Cannot be undone: ask the user first and pass confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        prototype: refInput,
        confirm: z.boolean().optional().describe('true — the user confirmed the deletion'),
      }),
      async run({ prototype: ref, confirm }) {
        const p = find(ref)
        if (confirm !== true) return t`Not deleted. Ask the user and repeat with confirm: true.
To be deleted: “${p.title}” (${publicUrl(p.slug)})`
        remove(p)
        return t`Deleted prototype “${p.title}”`
      },
    }),
  ],
})
