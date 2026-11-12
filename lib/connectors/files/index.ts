import { localeTag, t, tr, trc } from '../../i18n'
import { constants, createReadStream, type Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { createLink, LINK_KIND_TEXT, linkUrl } from '../../download-links'
import { formatDate, formatSize, plural, truncate } from '../format'
import { defineConnector, field, toolFor, ToolError } from '../types'
import { DEFAULT_DENY } from './deny'
import { ACCESS_LABEL, allows, code, folderList, fsCall, fsMessage, parseFolders, resolveTarget, type Folder, type Target } from './folders'

const configSchema = z
  .object({
    folders: field(z.string().default(''), {
      label: 'Folders',
      widget: 'textarea',
      placeholder: 'Documents | /files/docs | edit\nPhotos | /files/photos | read\n/files/inbox | add',
      help: 'One line per folder: “name | path in the container | mode”. Modes: read — read only, add — also create new files and folders, edit — also edit, rename and move, full — also delete. The path is as in the docker-compose volumes; without a name the folder name is used, without a mode — read.',
      section: 'connection',
    }),
    deny: field(z.string().default(DEFAULT_DENY), {
      label: 'Forbidden files',
      widget: 'textarea',
      mono: true,
      placeholder: DEFAULT_DENY,
      help: 'One mask per line: * — any characters, ? — one. The mask is checked on every name in the path, “.ssh” closes the whole folder. Such files are not read, searched, copied or given as links; the list shows only the name. Empty — nothing is forbidden',
      section: 'defaults',
    }),
  })
  .superRefine((c, ctx) => {
    const r = parseFolders(c.folders)
    if (!r.ok) ctx.addIssue({ code: 'custom', path: ['folders'], message: r.error })
  })

type Config = z.output<typeof configSchema>
const tool = toolFor<Config>()

const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const MAX_IMAGE = 3 * 1024 * 1024
const MAX_EDIT = 5 * 1024 * 1024
const MAX_READ_CHARS = 40_000
const MAX_LINE = 2000
const SEARCH_ENTRIES = 20_000
const SEARCH_MS = 20_000

// Measured on prototypes: one tool argument breaks at ~10 KB on Claude's side.
const CHUNK_HINT = 'Write text over ~5 KB in parts of 4–5 KB: the first part with mode: "create" (or "overwrite"), the rest with mode: "append".'

/**
 * Files the hub created recently: in an «add» folder the model may keep appending to
 * a file it has just created (chunked writes), but not to files that were there before.
 */
const created = new Map<string, number>()
const CREATED_TTL = 60 * 60 * 1000

function rememberCreated(abs: string) {
  const now = Date.now()
  for (const [k, at] of created) if (now - at > CREATED_TTL) created.delete(k)
  created.set(abs, now)
}

const folders = (c: Config) => folderList(c.folders, c.deny)
const pathInput = z.string().min(1).describe('A path like “folder/subfolder/file”; the first part is a folder name from files_list')

async function statOrNull(abs: string) {
  try {
    return await fs.lstat(abs)
  } catch (e) {
    if (code(e) === 'ENOENT') return null
    throw e
  }
}

async function isBinary(abs: string): Promise<boolean> {
  const fh = await fs.open(abs, 'r')
  try {
    const buf = Buffer.alloc(8000)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).includes(0)
  } finally {
    await fh.close()
  }
}

/** Write through a temp file next to the target, so a failed write never leaves half a file. */
async function writeAtomic(abs: string, data: string) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.hub-${process.pid}-${Date.now()}`)
  try {
    await fs.writeFile(tmp, data, 'utf8')
    await fs.rename(tmp, abs)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

function entryLine(name: string, isDir: boolean, size: number, mtime: Date, indent = ''): string {
  return isDir ? `${indent}• ${name}/` : `${indent}• ${name} — ${formatSize(size)} · ${formatDate(mtime)}`
}

const byDirThenName = (a: Dirent, b: Dirent) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, localeTag())

/** Total size and file count of a directory, with a cap so a huge tree does not hang the call. */
async function treeStats(abs: string, cap = 20_000): Promise<{ files: number; dirs: number; bytes: number; partial: boolean }> {
  const out = { files: 0, dirs: 0, bytes: 0, partial: false }
  const stack = [abs]
  let seen = 0
  while (stack.length) {
    const dir = stack.pop()!
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      if (++seen > cap) return { ...out, partial: true }
      const p = path.join(dir, d.name)
      if (d.isDirectory()) {
        out.dirs++
        stack.push(p)
      } else {
        out.files++
        out.bytes += (await fs.lstat(p)).size
      }
    }
  }
  return out
}

/** «to» that is an existing folder means «into that folder», like mv and cp. */
async function destination(list: Folder[], src: Target, to: string): Promise<Target> {
  let dst = await resolveTarget(list, to, 'add')
  const st = await statOrNull(dst.abs)
  if (st?.isDirectory()) dst = await resolveTarget(list, `${dst.shown}/${path.basename(src.abs)}`, 'add')
  if (dst.abs === src.abs || dst.abs.startsWith(src.abs + path.sep)) throw new ToolError(t`“${src.shown}” cannot be put inside itself`)
  if (await statOrNull(dst.abs)) throw new ToolError(t`“${dst.shown}” already exists — pick another name or delete it first`)
  return dst
}

export const files = defineConnector<Config>({
  id: 'files',
  name: 'Files',
  description: 'Folders mounted into the hub container',
  configSchema,

  instructions(c, { tools }) {
    const own = tools.filter((t) => t.startsWith('files_'))
    if (own.length === 0) return null
    // The admin form asks for the text before the connector is configured: config is {} then.
    const r = parseFolders(c.folders ?? '')
    if (!r.ok) return null
    const list = r.folders.map((f) => `${f.name} — ${tr(ACCESS_LABEL[f.access])}`).join('; ')
    const parts = [t`Files: paths like “folder/subfolder/file”. Folders: ${list}.`]
    if (own.includes('files_write')) parts.push(tr(CHUNK_HINT))
    if (own.includes('files_edit')) parts.push(t`For small text edits use files_edit, without rewriting the whole file.`)
    if (own.includes('files_link')) parts.push(t`A shareable file link — only on a direct request.`)
    return parts.join(' ')
  },

  async test(c) {
    const r = parseFolders(c.folders)
    if (!r.ok) return { ok: false, summary: r.error, details: [] }
    const details: string[] = []
    let failed: string | null = null
    for (const f of r.folders) {
      try {
        const st = await fs.stat(f.root)
        if (!st.isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' })
        await fs.access(f.root, allows(f, 'add') ? constants.R_OK | constants.W_OK : constants.R_OK)
        const n = (await fs.readdir(f.root)).length
        details.push(`${f.name}: ${tr(ACCESS_LABEL[f.access])}, ${n} ${plural(n, ['item', 'items'])}`)
      } catch (e) {
        const msg = `${f.name}: ${code(e) === 'ENOENT' ? t`${f.root} is not in the container — mount it through volumes` : fsMessage(e, f.root)}`
        details.push(msg)
        failed ??= msg
      }
    }
    const n = r.folders.length
    return { ok: !failed, summary: failed ?? `${n} ${plural(n, ['folder', 'folders'])}`, details }
  },

  tools: [
    tool({
      name: 'files_list',
      title: 'List files',
      description: 'Without path — the available folders and their access. With path — the folder content (depth up to 3 levels) or file details: size, date.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: z.string().optional().describe('Folder or file: “folder/subfolder”. Empty — the folder list'),
        depth: z.number().int().min(1).max(3).default(1).describe('How many nesting levels to show'),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      async run(args, { config }) {
        const list = folders(config)
        if (!args.path || !args.path.replace(/[\\/.\s]/g, '')) {
          return [t`Folders:`, ...list.map((f) => `• ${f.name}/ — ${tr(ACCESS_LABEL[f.access])}`)].join('\n')
        }
        const item = await resolveTarget(list, args.path, 'read')
        const st = await fsCall(item.shown, () => fs.stat(item.abs))
        if (!st.isDirectory()) {
          return [`${item.shown}`, t`${formatSize(st.size)} · modified ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}`, t`Folder “${item.folder.name}”: ${tr(ACCESS_LABEL[item.folder.access])}`].join('\n')
        }
        const lines: string[] = []
        let total = 0
        let more = false
        const walk = async (dir: string, level: number, prefix: string) => {
          const entries = (await fsCall(item.shown, () => fs.readdir(dir, { withFileTypes: true }))).sort(byDirThenName)
          for (const d of entries) {
            total++
            if (lines.length >= args.limit) {
              more = true
              continue
            }
            const p = path.join(dir, d.name)
            if (item.folder.deny?.(d.name)) {
              lines.push(t`${prefix}• ${d.name}${d.isDirectory() ? '/' : ''} — closed`)
              continue
            }
            const s = await fs.lstat(p).catch(() => null)
            lines.push(entryLine(d.name, d.isDirectory(), s?.size ?? 0, s?.mtime ?? new Date(0), prefix))
            if (d.isDirectory() && level < args.depth) await walk(p, level + 1, `${prefix}   `)
          }
        }
        await walk(item.abs, 1, '')
        if (total === 0) return t`“${item.shown}” is empty.`
        const head = `${item.shown}/ — ${tr(ACCESS_LABEL[item.folder.access])}:`
        return [head, ...lines, ...(more ? [t`…showing ${lines.length} of ${total}, raise limit or open a subfolder`] : [])].join('\n')
      },
    }),

    tool({
      name: 'files_read',
      title: 'Read file',
      description: 'Read a text file by lines (offset, limit) or an image (png, jpg, gif, webp up to 3 MB). A long file in parts: the reply gives the next offset.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: pathInput,
        offset: z.number().int().min(1).default(1).describe('Line to start from, from 1'),
        limit: z.number().int().min(1).max(5000).default(500).describe('How many lines'),
      }),
      async run(args, { config }) {
        const item = await resolveTarget(folders(config), args.path, 'read')
        const st = await fsCall(item.shown, () => fs.stat(item.abs))
        if (st.isDirectory()) throw new ToolError(t`“${item.shown}” is a folder, files_list shows its content`)
        const mime = IMAGE[path.extname(item.abs).toLowerCase()]
        if (mime) {
          if (st.size > MAX_IMAGE) return t`${item.shown} — an image of ${formatSize(st.size)}, over 3 MB: it cannot be shown.`
          const data = await fsCall(item.shown, () => fs.readFile(item.abs))
          return { text: `${item.shown} · ${formatSize(st.size)}`, images: [{ data: data.toString('base64'), mimeType: mime }] }
        }
        if (await fsCall(item.shown, () => isBinary(item.abs))) return t`${item.shown} — a binary file of ${formatSize(st.size)}, it cannot be read as text.`

        const out: string[] = []
        let chars = 0
        let n = 0
        let next: number | null = null
        const rl = createInterface({ input: createReadStream(item.abs, 'utf8'), crlfDelay: Infinity })
        for await (const raw of rl) {
          n++
          if (n < args.offset || next !== null) continue
          const line = raw.length > MAX_LINE ? t`${raw.slice(0, MAX_LINE)}… [line cut]` : raw
          if (out.length >= args.limit || chars + line.length > MAX_READ_CHARS) {
            next = n
            continue
          }
          out.push(line)
          chars += line.length + 1
        }
        if (n === 0) return t`${item.shown} — an empty file.`
        if (args.offset > n) return t`“${item.shown}” has only ${n} ${plural(n, ['line', 'lines'])}.`
        const last = args.offset + out.length - 1
        const head = `${item.shown} · ${formatSize(st.size)} · ${n} ${plural(n, ['line', 'lines'])}${args.offset > 1 || next ? t` · lines ${args.offset}–${last}` : ''}`
        return [head, '', ...out, ...(next ? ['', t`…next: offset ${next}`] : [])].join('\n')
      },
    }),

    tool({
      name: 'files_link',
      title: 'Download link',
      description:
        'A link to download or open the file in a browser (PDF, images and video open right away). Personal by default: works for 24 hours and only in a browser signed in to the hub admin panel. shareable: true — only when the user directly asked for a link to forward: opens for anyone, once, within 15 minutes.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        path: pathInput,
        shareable: z.boolean().default(false).describe('true — a shareable one-time link for 15 minutes'),
      }),
      async run(args, { config }) {
        const item = await resolveTarget(folders(config), args.path, 'read')
        const st = await fsCall(item.shown, () => fs.stat(item.abs))
        if (st.isDirectory()) throw new ToolError(t`“${item.shown}” is a folder; a link can only point to a file`)
        const { token } = createLink({ connectorId: 'files', path: item.shown }, { shareable: args.shareable })
        return [`${item.shown} · ${formatSize(st.size)}:`, linkUrl(token), args.shareable ? tr(LINK_KIND_TEXT.shareable) : tr(LINK_KIND_TEXT.personal)].join('\n')
      },
    }),

    tool({
      name: 'files_search',
      title: 'Find files',
      description: 'Find files by name (a substring or a mask like *.pdf) and/or by text inside (text files up to 5 MB). Without path — in all folders.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: z.string().optional().describe('Where to search: a folder or subfolder. Empty — everywhere'),
        name: z.string().optional().describe('Part of the name or a mask: “report”, “*.pdf”, “IMG_2026*”'),
        text: z.string().optional().describe('Text inside the file, case-insensitive'),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      async run(args, { config }) {
        if (!args.name && !args.text) throw new ToolError(t`name or text is required`)
        const list = folders(config)
        // Without path a folder that is not mounted is skipped rather than failing the whole search.
        const starts = args.path
          ? [await resolveTarget(list, args.path, 'read')]
          : (await Promise.allSettled(list.map((f) => resolveTarget(list, f.name, 'read')))).flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
        const mask = args.name && /[*?]/.test(args.name)
        const nameRe = args.name
          ? mask
            ? new RegExp(`^${args.name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
            : null
          : null
        const nameNeedle = args.name?.toLowerCase()
        const textNeedle = args.text?.toLowerCase()
        const deadline = Date.now() + SEARCH_MS
        const hits: string[] = []
        let visited = 0
        let partial = false

        const nameOk = (n: string) => !args.name || (nameRe ? nameRe.test(n) : n.toLowerCase().includes(nameNeedle!))
        const textHit = async (abs: string, size: number): Promise<string | null> => {
          if (size > MAX_EDIT || (await isBinary(abs).catch(() => true))) return null
          const lines = (await fs.readFile(abs, 'utf8')).split('\n')
          const i = lines.findIndex((l) => l.toLowerCase().includes(textNeedle!))
          return i === -1 ? null : `${i + 1}: ${truncate(lines[i]!.trim(), 120)}`
        }

        for (const start of starts) {
          const stack: [string, string][] = [[start.abs, start.shown]]
          while (stack.length && hits.length < args.limit) {
            if (visited > SEARCH_ENTRIES || Date.now() > deadline) {
              partial = true
              break
            }
            const [dir, shown] = stack.pop()!
            const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])
            for (const d of entries.sort(byDirThenName)) {
              if (hits.length >= args.limit) break
              visited++
              // Closed names are neither found nor searched inside.
              if (start.folder.deny?.(d.name)) continue
              const abs = path.join(dir, d.name)
              const rel = `${shown}/${d.name}`
              // Symlinked folders are not followed: they may lead outside the mount.
              if (d.isDirectory()) {
                stack.push([abs, rel])
                if (!textNeedle && nameOk(d.name)) hits.push(`• ${rel}/`)
                continue
              }
              if (!d.isFile() || !nameOk(d.name)) continue
              const st = await fs.stat(abs).catch(() => null)
              if (!st) continue
              if (!textNeedle) {
                hits.push(`• ${rel} — ${formatSize(st.size)} · ${formatDate(st.mtime)}`)
                continue
              }
              const line = await textHit(abs, st.size).catch(() => null)
              if (line) hits.push(t`• ${rel} — line ${line}`)
            }
          }
          if (partial || hits.length >= args.limit) break
        }
        if (hits.length === 0) return partial ? t`Nothing found in the part searched — narrow the search with path.` : trc('search', 'Nothing found.')
        const tail = partial ? [t`…the search stopped halfway — narrow path`] : hits.length >= args.limit ? [t`…showing the first ${args.limit}`] : []
        return [t`Found ${hits.length}:`, ...hits, ...tail].join('\n')
      },
    }),

    tool({
      name: 'files_write',
      title: 'Write file',
      description: `Create a text file, overwrite it or append to the end. Missing subfolders are created. ${CHUNK_HINT}`,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        path: pathInput,
        content: z.string().describe('UTF-8 text'),
        mode: z.enum(['create', 'overwrite', 'append']).default('create').describe('create — only a new file, overwrite — replace entirely, append — add to the end'),
      }),
      async run(args, { config }) {
        const list = folders(config)
        const item = await resolveTarget(list, args.path, 'add')
        if (item.isRoot) throw new ToolError(t`Give a file name inside the folder`)
        const st = await fsCall(item.shown, () => statOrNull(item.abs))
        if (st?.isDirectory()) throw new ToolError(t`“${item.shown}” is a folder`)
        if (st && args.mode === 'create') throw new ToolError(t`“${item.shown}” already exists (${formatSize(st.size)}). Replace — mode: "overwrite", append — mode: "append"`)
        // Changing an existing file is «edit», except appending to a file the hub has just created.
        if (st && !(args.mode === 'append' && created.has(item.abs))) await resolveTarget(list, args.path, 'edit')

        await fsCall(item.shown, () => fs.mkdir(path.dirname(item.abs), { recursive: true }))
        if (args.mode === 'append' && st) await fsCall(item.shown, () => fs.appendFile(item.abs, args.content, 'utf8'))
        else if (st) await fsCall(item.shown, () => writeAtomic(item.abs, args.content))
        else await fsCall(item.shown, () => fs.writeFile(item.abs, args.content, { encoding: 'utf8', flag: 'wx' }))
        if (!st) rememberCreated(item.abs)

        const size = (await fs.stat(item.abs)).size
        const verb = !st ? trc('file', 'Created') : args.mode === 'append' ? t`Appended` : t`Overwritten`
        return `${verb} ${item.shown} · ${formatSize(size)}`
      },
    }),

    tool({
      name: 'files_edit',
      title: 'Edit text',
      description: 'Replace a piece of text in a file: old_text must occur exactly once (or all: true — replace all). For small edits without rewriting the file.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        path: pathInput,
        old_text: z.string().min(1).describe('The exact piece from the file, with spaces and line breaks'),
        new_text: z.string().describe('What to replace with; empty — delete the piece'),
        all: z.boolean().default(false).describe('true — replace all occurrences'),
      }),
      async run(args, { config }) {
        const item = await resolveTarget(folders(config), args.path, 'edit')
        const st = await fsCall(item.shown, () => fs.stat(item.abs))
        if (st.isDirectory()) throw new ToolError(t`“${item.shown}” is a folder`)
        if (st.size > MAX_EDIT) throw new ToolError(t`“${item.shown}” is over 5 MB — editing is not supported`)
        if (await isBinary(item.abs)) throw new ToolError(t`“${item.shown}” is a binary file`)
        const text = await fsCall(item.shown, () => fs.readFile(item.abs, 'utf8'))
        const count = text.split(args.old_text).length - 1
        if (count === 0) throw new ToolError(t`The piece was not found in “${item.shown}” — check the text with files_read (spaces and line breaks matter)`)
        if (count > 1 && !args.all) throw new ToolError(t`The piece occurs ${count} times — make it more exact or pass all: true`)
        await fsCall(item.shown, () => writeAtomic(item.abs, text.split(args.old_text).join(args.new_text)))
        return t`Edited in ${item.shown}: ${count} ${plural(count, ['replacement', 'replacements'])}`
      },
    }),

    tool({
      name: 'files_mkdir',
      title: 'Create folder',
      description: 'Create a subfolder (with the missing parent folders).',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ path: pathInput }),
      async run(args, { config }) {
        const item = await resolveTarget(folders(config), args.path, 'add')
        const st = await fsCall(item.shown, () => statOrNull(item.abs))
        if (st?.isDirectory()) return t`Folder ${item.shown}/ already exists.`
        if (st) throw new ToolError(t`“${item.shown}” already exists, and it is a file`)
        await fsCall(item.shown, () => fs.mkdir(item.abs, { recursive: true }))
        return t`Created folder ${item.shown}/`
      },
    }),

    tool({
      name: 'files_move',
      title: 'Move',
      description: 'Move or rename a file or folder, also between folders. If to is an existing folder, puts it inside. Does not overwrite what exists.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        from: pathInput.describe('What to move'),
        to: pathInput.describe('The new path or the target folder'),
      }),
      async run(args, { config }) {
        const list = folders(config)
        const src = await resolveTarget(list, args.from, 'edit')
        if (src.isRoot) throw new ToolError(t`A folder from the settings cannot be moved itself — only its content`)
        await fsCall(src.shown, () => fs.lstat(src.abs))
        const dst = await destination(list, src, args.to)
        await fsCall(dst.shown, () => fs.mkdir(path.dirname(dst.abs), { recursive: true }))
        try {
          await fs.rename(src.abs, dst.abs)
        } catch (e) {
          // Different mounts: copy, then remove the original.
          if (code(e) !== 'EXDEV') throw new ToolError(fsMessage(e, src.shown))
          await fsCall(dst.shown, () => fs.cp(src.abs, dst.abs, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }))
          await fsCall(src.shown, () => fs.rm(src.abs, { recursive: true }))
        }
        return t`Moved: ${src.shown} → ${dst.shown}`
      },
    }),

    tool({
      name: 'files_copy',
      title: 'Copy file',
      description: 'Copy a file or a whole folder, also between folders. If to is an existing folder, puts the copy inside. Does not overwrite what exists.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        from: pathInput.describe('What to copy'),
        to: pathInput.describe('The copy path or the target folder'),
      }),
      async run(args, { config }) {
        const list = folders(config)
        const src = await resolveTarget(list, args.from, 'read')
        if (src.isRoot) throw new ToolError(t`Give a file or subfolder inside the folder`)
        await fsCall(src.shown, () => fs.lstat(src.abs))
        const dst = await destination(list, src, args.to)
        await fsCall(dst.shown, () => fs.mkdir(path.dirname(dst.abs), { recursive: true }))
        // verbatimSymlinks: a link is copied as a link, never as the file it points to outside the folder.
        await fsCall(dst.shown, () => fs.cp(src.abs, dst.abs, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true }))
        return t`Copied: ${src.shown} → ${dst.shown}`
      },
    }),

    tool({
      name: 'files_delete',
      title: 'Delete',
      description: 'Delete a file or a folder with all its content. Cannot be undone: ask the user first and pass confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: pathInput,
        confirm: z.boolean().optional().describe('true — the user confirmed the deletion'),
      }),
      async run(args, { config }) {
        const target = await resolveTarget(folders(config), args.path, 'full')
        if (target.isRoot) throw new ToolError(t`A folder from the settings cannot be deleted itself — only its content`)
        const st = await fsCall(target.shown, () => fs.lstat(target.abs))
        let what = t`file ${target.shown} (${formatSize(st.size)})`
        if (st.isDirectory()) {
          const s = await fsCall(target.shown, () => treeStats(target.abs))
          what = t`folder ${target.shown}/ — ${s.partial ? t`over ` : ''}${s.files} ${plural(s.files, ['file', 'files'])}, ${formatSize(s.bytes)}`
        }
        // English «To be deleted:», Russian «Будет удалена / удалён» (the gender follows the object).
        const gone = st.isDirectory() ? trc('folder', 'To be deleted:') : trc('file', 'To be deleted:')
        if (args.confirm !== true) return t`Not deleted. Ask the user and repeat with confirm: true.\n${gone} ${what}`
        await fsCall(target.shown, () => fs.rm(target.abs, { recursive: true }))
        created.delete(target.abs)
        return t`Deleted: ${what}`
      },
    }),
  ],
})
