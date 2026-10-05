import { constants, createReadStream, type Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { createLink, LINK_KIND_TEXT, linkUrl } from '../../download-links'
import { formatDate, formatSize, plural, truncate } from '../format'
import { defineConnector, field, toolFor, ToolError } from '../types'
import { ACCESS_LABEL, allows, code, folderList, fsCall, fsMessage, parseFolders, resolveTarget, type Folder, type Target } from './folders'

const configSchema = z
  .object({
    folders: field(z.string().default(''), {
      label: 'Папки',
      widget: 'textarea',
      placeholder: 'Документы | /files/docs | edit\nФото | /files/photos | read\n/files/inbox | add',
      help: 'По строке на папку: «имя | путь в контейнере | режим». Режимы: read — только чтение, add — ещё создание новых файлов и папок, edit — ещё правка, переименование и перенос, full — ещё удаление. Путь — как в volumes docker-compose; без имени берётся имя папки, без режима — read.',
      section: 'connection',
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
const CHUNK_HINT = 'Текст больше ~5 КБ пиши частями по 4–5 КБ: первый кусок с mode: "create" (или "overwrite"), остальные — с mode: "append".'

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

const folders = (c: Config) => folderList(c.folders)
const pathInput = z.string().min(1).describe('Путь вида «папка/подпапка/файл»; первая часть — имя папки из files_list')

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

const byDirThenName = (a: Dirent, b: Dirent) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'ru')

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
  if (dst.abs === src.abs || dst.abs.startsWith(src.abs + path.sep)) throw new ToolError(`Нельзя положить «${src.shown}» внутрь самого себя`)
  if (await statOrNull(dst.abs)) throw new ToolError(`«${dst.shown}» уже существует — выбери другое имя или сначала удали`)
  return dst
}

export const files = defineConnector<Config>({
  id: 'files',
  name: 'Файлы',
  description: 'Папки, смонтированные в контейнер хаба',
  configSchema,

  instructions(c, { tools }) {
    const own = tools.filter((t) => t.startsWith('files_'))
    if (own.length === 0) return null
    const r = parseFolders(c.folders)
    if (!r.ok) return null
    const list = r.folders.map((f) => `${f.name} — ${ACCESS_LABEL[f.access]}`).join('; ')
    const parts = [`Файлы: пути вида «папка/подпапка/файл». Папки: ${list}.`]
    if (own.includes('files_write')) parts.push(CHUNK_HINT)
    if (own.includes('files_edit')) parts.push('Точечные правки текста — files_edit, без перезаписи всего файла.')
    if (own.includes('files_link')) parts.push('Пересылаемую ссылку на файл (shareable) — только по прямой просьбе.')
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
        details.push(`${f.name}: ${ACCESS_LABEL[f.access]}, ${n} ${plural(n, ['объект', 'объекта', 'объектов'])}`)
      } catch (e) {
        const msg = `${f.name}: ${code(e) === 'ENOENT' ? `${f.root} нет в контейнере — смонтируй через volumes` : fsMessage(e, f.root)}`
        details.push(msg)
        failed ??= msg
      }
    }
    const n = r.folders.length
    return { ok: !failed, summary: failed ?? `${n} ${plural(n, ['папка', 'папки', 'папок'])}`, details }
  },

  tools: [
    tool({
      name: 'files_list',
      title: 'Список файлов',
      description: 'Без path — доступные папки и права на них. С path — содержимое папки (depth до 3 уровней) или сведения о файле: размер, дата.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: z.string().optional().describe('Папка или файл: «папка/подпапка». Пусто — список папок'),
        depth: z.number().int().min(1).max(3).default(1).describe('Сколько уровней вложенности показать'),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      async run(args, { config }) {
        const list = folders(config)
        if (!args.path || !args.path.replace(/[\\/.\s]/g, '')) {
          return ['Папки:', ...list.map((f) => `• ${f.name}/ — ${ACCESS_LABEL[f.access]}`)].join('\n')
        }
        const t = await resolveTarget(list, args.path, 'read')
        const st = await fsCall(t.shown, () => fs.stat(t.abs))
        if (!st.isDirectory()) {
          return [`${t.shown}`, `${formatSize(st.size)} · изменён ${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}`, `Папка «${t.folder.name}»: ${ACCESS_LABEL[t.folder.access]}`].join('\n')
        }
        const lines: string[] = []
        let total = 0
        let more = false
        const walk = async (dir: string, level: number, prefix: string) => {
          const entries = (await fsCall(t.shown, () => fs.readdir(dir, { withFileTypes: true }))).sort(byDirThenName)
          for (const d of entries) {
            total++
            if (lines.length >= args.limit) {
              more = true
              continue
            }
            const p = path.join(dir, d.name)
            const s = await fs.lstat(p).catch(() => null)
            lines.push(entryLine(d.name, d.isDirectory(), s?.size ?? 0, s?.mtime ?? new Date(0), prefix))
            if (d.isDirectory() && level < args.depth) await walk(p, level + 1, `${prefix}   `)
          }
        }
        await walk(t.abs, 1, '')
        if (total === 0) return `«${t.shown}» пуста.`
        const head = `${t.shown}/ — ${ACCESS_LABEL[t.folder.access]}:`
        return [head, ...lines, ...(more ? [`…показано ${lines.length} из ${total}, увеличь limit или открой подпапку`] : [])].join('\n')
      },
    }),

    tool({
      name: 'files_read',
      title: 'Прочитать файл',
      description: 'Прочитать текстовый файл по строкам (offset, limit) или картинку (png, jpg, gif, webp до 3 МБ). Длинный файл — частями: ответ подскажет следующий offset.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: pathInput,
        offset: z.number().int().min(1).default(1).describe('С какой строки читать, от 1'),
        limit: z.number().int().min(1).max(5000).default(500).describe('Сколько строк'),
      }),
      async run(args, { config }) {
        const t = await resolveTarget(folders(config), args.path, 'read')
        const st = await fsCall(t.shown, () => fs.stat(t.abs))
        if (st.isDirectory()) throw new ToolError(`«${t.shown}» — папка, её содержимое покажет files_list`)
        const mime = IMAGE[path.extname(t.abs).toLowerCase()]
        if (mime) {
          if (st.size > MAX_IMAGE) return `${t.shown} — картинка ${formatSize(st.size)}, больше 3 МБ: показать не получится.`
          const data = await fsCall(t.shown, () => fs.readFile(t.abs))
          return { text: `${t.shown} · ${formatSize(st.size)}`, images: [{ data: data.toString('base64'), mimeType: mime }] }
        }
        if (await fsCall(t.shown, () => isBinary(t.abs))) return `${t.shown} — двоичный файл ${formatSize(st.size)}, как текст не читается.`

        const out: string[] = []
        let chars = 0
        let n = 0
        let next: number | null = null
        const rl = createInterface({ input: createReadStream(t.abs, 'utf8'), crlfDelay: Infinity })
        for await (const raw of rl) {
          n++
          if (n < args.offset || next !== null) continue
          const line = raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)}… [строка обрезана]` : raw
          if (out.length >= args.limit || chars + line.length > MAX_READ_CHARS) {
            next = n
            continue
          }
          out.push(line)
          chars += line.length + 1
        }
        if (n === 0) return `${t.shown} — пустой файл.`
        if (args.offset > n) return `В «${t.shown}» всего ${n} ${plural(n, ['строка', 'строки', 'строк'])}.`
        const last = args.offset + out.length - 1
        const head = `${t.shown} · ${formatSize(st.size)} · ${n} ${plural(n, ['строка', 'строки', 'строк'])}${args.offset > 1 || next ? ` · строки ${args.offset}–${last}` : ''}`
        return [head, '', ...out, ...(next ? ['', `…дальше: offset ${next}`] : [])].join('\n')
      },
    }),

    tool({
      name: 'files_link',
      title: 'Ссылка на скачивание',
      description:
        'Ссылка, чтобы скачать или открыть файл в браузере (PDF, картинки и видео открываются сразу). По умолчанию личная: работает 24 часа и только в браузере, где пользователь вошёл в админку хаба. shareable: true — только если пользователь прямо попросил ссылку, чтобы переслать: открывается у любого, один раз, 15 минут.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        path: pathInput,
        shareable: z.boolean().default(false).describe('true — пересылаемая одноразовая ссылка на 15 минут'),
      }),
      async run(args, { config }) {
        const t = await resolveTarget(folders(config), args.path, 'read')
        const st = await fsCall(t.shown, () => fs.stat(t.abs))
        if (st.isDirectory()) throw new ToolError(`«${t.shown}» — папка; ссылка бывает только на файл`)
        const { token } = createLink({ connectorId: 'files', path: t.shown }, { shareable: args.shareable })
        return [`${t.shown} · ${formatSize(st.size)}:`, linkUrl(token), args.shareable ? LINK_KIND_TEXT.shareable : LINK_KIND_TEXT.personal].join('\n')
      },
    }),

    tool({
      name: 'files_search',
      title: 'Найти файлы',
      description: 'Найти файлы по имени (подстрока или маска *.pdf) и/или по тексту внутри (текстовые файлы до 5 МБ). Без path — во всех папках.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: z.string().optional().describe('Где искать: папка или подпапка. Пусто — везде'),
        name: z.string().optional().describe('Часть имени или маска: «отчёт», «*.pdf», «IMG_2026*»'),
        text: z.string().optional().describe('Текст внутри файла, без учёта регистра'),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      async run(args, { config }) {
        if (!args.name && !args.text) throw new ToolError('Нужно name или text')
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
              if (line) hits.push(`• ${rel} — строка ${line}`)
            }
          }
          if (partial || hits.length >= args.limit) break
        }
        if (hits.length === 0) return partial ? 'Ничего не нашлось в просмотренной части — сузь поиск через path.' : 'Ничего не нашлось.'
        const tail = partial ? ['…поиск остановлен на полпути — сузь path'] : hits.length >= args.limit ? [`…показаны первые ${args.limit}`] : []
        return [`Найдено ${hits.length}:`, ...hits, ...tail].join('\n')
      },
    }),

    tool({
      name: 'files_write',
      title: 'Записать файл',
      description: `Создать текстовый файл, перезаписать его или дописать в конец. Недостающие подпапки создаются. ${CHUNK_HINT}`,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        path: pathInput,
        content: z.string().describe('Текст в UTF-8'),
        mode: z.enum(['create', 'overwrite', 'append']).default('create').describe('create — только новый файл, overwrite — заменить целиком, append — дописать в конец'),
      }),
      async run(args, { config }) {
        const list = folders(config)
        const t = await resolveTarget(list, args.path, 'add')
        if (t.isRoot) throw new ToolError('Укажи имя файла внутри папки')
        const st = await fsCall(t.shown, () => statOrNull(t.abs))
        if (st?.isDirectory()) throw new ToolError(`«${t.shown}» — папка`)
        if (st && args.mode === 'create') throw new ToolError(`«${t.shown}» уже есть (${formatSize(st.size)}). Заменить — mode: "overwrite", дописать — mode: "append"`)
        // Changing an existing file is «edit», except appending to a file the hub has just created.
        if (st && !(args.mode === 'append' && created.has(t.abs))) await resolveTarget(list, args.path, 'edit')

        await fsCall(t.shown, () => fs.mkdir(path.dirname(t.abs), { recursive: true }))
        if (args.mode === 'append' && st) await fsCall(t.shown, () => fs.appendFile(t.abs, args.content, 'utf8'))
        else if (st) await fsCall(t.shown, () => writeAtomic(t.abs, args.content))
        else await fsCall(t.shown, () => fs.writeFile(t.abs, args.content, { encoding: 'utf8', flag: 'wx' }))
        if (!st) rememberCreated(t.abs)

        const size = (await fs.stat(t.abs)).size
        const verb = !st ? 'Создан' : args.mode === 'append' ? 'Дописан' : 'Перезаписан'
        return `${verb} ${t.shown} · ${formatSize(size)}`
      },
    }),

    tool({
      name: 'files_edit',
      title: 'Править текст',
      description: 'Заменить фрагмент текста в файле: old_text должен встречаться ровно один раз (или all: true — заменить все). Для точечных правок без перезаписи файла.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        path: pathInput,
        old_text: z.string().min(1).describe('Точный фрагмент из файла, с пробелами и переносами'),
        new_text: z.string().describe('Чем заменить; пусто — удалить фрагмент'),
        all: z.boolean().default(false).describe('true — заменить все вхождения'),
      }),
      async run(args, { config }) {
        const t = await resolveTarget(folders(config), args.path, 'edit')
        const st = await fsCall(t.shown, () => fs.stat(t.abs))
        if (st.isDirectory()) throw new ToolError(`«${t.shown}» — папка`)
        if (st.size > MAX_EDIT) throw new ToolError(`«${t.shown}» больше 5 МБ — правка не поддерживается`)
        if (await isBinary(t.abs)) throw new ToolError(`«${t.shown}» — двоичный файл`)
        const text = await fsCall(t.shown, () => fs.readFile(t.abs, 'utf8'))
        const count = text.split(args.old_text).length - 1
        if (count === 0) throw new ToolError(`Фрагмент не найден в «${t.shown}» — сверь текст через files_read (пробелы и переносы важны)`)
        if (count > 1 && !args.all) throw new ToolError(`Фрагмент встречается ${count} раз — уточни его или передай all: true`)
        await fsCall(t.shown, () => writeAtomic(t.abs, text.split(args.old_text).join(args.new_text)))
        return `Исправлено в ${t.shown}: ${count} ${plural(count, ['замена', 'замены', 'замен'])}`
      },
    }),

    tool({
      name: 'files_mkdir',
      title: 'Создать папку',
      description: 'Создать подпапку (вместе с недостающими родительскими).',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ path: pathInput }),
      async run(args, { config }) {
        const t = await resolveTarget(folders(config), args.path, 'add')
        const st = await fsCall(t.shown, () => statOrNull(t.abs))
        if (st?.isDirectory()) return `Папка ${t.shown}/ уже есть.`
        if (st) throw new ToolError(`«${t.shown}» уже есть, и это файл`)
        await fsCall(t.shown, () => fs.mkdir(t.abs, { recursive: true }))
        return `Создана папка ${t.shown}/`
      },
    }),

    tool({
      name: 'files_move',
      title: 'Переместить',
      description: 'Переместить или переименовать файл или папку, в том числе между папками. Если to — существующая папка, кладёт внутрь неё. Существующее не перезаписывает.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        from: pathInput.describe('Что переместить'),
        to: pathInput.describe('Новый путь или папка назначения'),
      }),
      async run(args, { config }) {
        const list = folders(config)
        const src = await resolveTarget(list, args.from, 'edit')
        if (src.isRoot) throw new ToolError('Саму папку из настроек переместить нельзя — только её содержимое')
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
        return `Перемещено: ${src.shown} → ${dst.shown}`
      },
    }),

    tool({
      name: 'files_copy',
      title: 'Копировать',
      description: 'Скопировать файл или папку целиком, в том числе между папками. Если to — существующая папка, кладёт копию внутрь. Существующее не перезаписывает.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        from: pathInput.describe('Что скопировать'),
        to: pathInput.describe('Путь копии или папка назначения'),
      }),
      async run(args, { config }) {
        const list = folders(config)
        const src = await resolveTarget(list, args.from, 'read')
        if (src.isRoot) throw new ToolError('Укажи файл или подпапку внутри папки')
        await fsCall(src.shown, () => fs.lstat(src.abs))
        const dst = await destination(list, src, args.to)
        await fsCall(dst.shown, () => fs.mkdir(path.dirname(dst.abs), { recursive: true }))
        // verbatimSymlinks: a link is copied as a link, never as the file it points to outside the folder.
        await fsCall(dst.shown, () => fs.cp(src.abs, dst.abs, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true }))
        return `Скопировано: ${src.shown} → ${dst.shown}`
      },
    }),

    tool({
      name: 'files_delete',
      title: 'Удалить',
      description: 'Удалить файл или папку со всем содержимым. Необратимо: сначала переспроси пользователя и передай confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: pathInput,
        confirm: z.boolean().optional().describe('true — пользователь подтвердил удаление'),
      }),
      async run(args, { config }) {
        const t = await resolveTarget(folders(config), args.path, 'full')
        if (t.isRoot) throw new ToolError('Саму папку из настроек удалить нельзя — только её содержимое')
        const st = await fsCall(t.shown, () => fs.lstat(t.abs))
        let what = `файл ${t.shown} (${formatSize(st.size)})`
        if (st.isDirectory()) {
          const s = await fsCall(t.shown, () => treeStats(t.abs))
          what = `папка ${t.shown}/ — ${s.partial ? 'больше ' : ''}${s.files} ${plural(s.files, ['файл', 'файла', 'файлов'])}, ${formatSize(s.bytes)}`
        }
        if (args.confirm !== true) return `Не удалено. Переспроси пользователя и повтори с confirm: true.\nБудет ${st.isDirectory() ? 'удалена' : 'удалён'} ${what}`
        await fsCall(t.shown, () => fs.rm(t.abs, { recursive: true }))
        created.delete(t.abs)
        return `Удалено: ${what}`
      },
    }),
  ],
})
