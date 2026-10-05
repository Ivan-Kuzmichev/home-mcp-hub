import fs from 'node:fs/promises'
import path from 'node:path'
import { ToolError } from '../types'

// ---------------------------------------------------------------------------
// Folders from the connector settings: one per line, «name | /path | mode».

export const ACCESS = ['read', 'add', 'edit', 'full'] as const
export type Access = (typeof ACCESS)[number]

export const ACCESS_LABEL: Record<Access, string> = {
  read: 'только чтение',
  add: 'чтение и добавление',
  edit: 'чтение и правка',
  full: 'полный доступ',
}

const ACCESS_ALIASES: Record<string, Access> = {
  read: 'read',
  ro: 'read',
  чтение: 'read',
  add: 'add',
  добавление: 'add',
  edit: 'edit',
  rw: 'edit',
  правка: 'edit',
  full: 'full',
  полный: 'full',
}

export type Folder = { name: string; root: string; access: Access }

const NAME = /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u

/** Parse the folders text; returns the folders or the first error (line number included). */
export function parseFolders(text: string): { ok: true; folders: Folder[] } | { ok: false; error: string } {
  const folders: Folder[] = []
  const lines = text.split('\n')
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const fail = (msg: string) => ({ ok: false as const, error: `Строка ${i + 1}: ${msg}` })
    const parts = line.split('|').map((p) => p.trim())
    if (parts.length > 3) return fail('ожидается «имя | /путь | режим»')
    // «/path», «/path | mode», «name | /path», «name | /path | mode»
    const hasName = !parts[0]!.startsWith('/')
    const name = hasName ? parts[0]! : path.posix.basename(parts[0]!)
    const root = hasName ? parts[1] : parts[0]
    const mode = (hasName ? parts[2] : parts[1]) ?? 'read'
    if (!root) return fail('нет пути к папке')
    if (!root.startsWith('/')) return fail(`путь «${root}» должен быть абсолютным — как в volumes контейнера`)
    if (path.posix.normalize(root) === '/') return fail('корень контейнера открывать нельзя')
    if (!NAME.test(name)) return fail(`имя «${name}» — буквы, цифры, пробел, точка, дефис`)
    const access = ACCESS_ALIASES[mode.toLowerCase()]
    if (!access) return fail(`режим «${mode}» — read, add, edit или full`)
    if (folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) return fail(`имя «${name}» уже занято — задай другое: «имя | ${root}»`)
    folders.push({ name, root: path.posix.normalize(root).replace(/\/+$/, ''), access })
  }
  if (folders.length === 0) return { ok: false, error: 'Добавь хотя бы одну папку' }
  return { ok: true, folders }
}

export function folderList(text: string): Folder[] {
  const r = parseFolders(text)
  if (!r.ok) throw new ToolError(`Список папок в настройках коннектора с ошибкой: ${r.error}`)
  return r.folders
}

export function allows(f: Folder, need: Access): boolean {
  return ACCESS.indexOf(f.access) >= ACCESS.indexOf(need)
}

const NEED_TEXT: Record<Access, string> = {
  read: 'чтения',
  add: 'добавления файлов',
  edit: 'правки',
  full: 'удаления',
}

export function requireAccess(f: Folder, need: Access): void {
  if (!allows(f, need)) throw new ToolError(`Папка «${f.name}» открыта в режиме «${ACCESS_LABEL[f.access]}» — для ${NEED_TEXT[need]} нужен доступ выше. Его меняют в админке хаба.`)
}

// ---------------------------------------------------------------------------
// Paths. The model sees «folder/sub/file.txt»; the hub maps it to the mount and
// makes sure the real path (symlinks resolved) stays inside the folder.

export type Target = {
  folder: Folder
  /** Absolute path on disk */
  abs: string
  /** Path as the model sees it: «folder/sub/file.txt» */
  shown: string
  /** The folder itself */
  isRoot: boolean
}

export function splitPath(input: string): string[] {
  if (input.includes('\0')) throw new ToolError('Недопустимый символ в пути')
  const segments = input.split(/[\\/]+/).filter((s) => s && s !== '.')
  if (segments.includes('..')) throw new ToolError('«..» в пути нельзя — укажи путь от папки: папка/подпапка/файл')
  return segments
}

export function target(folders: Folder[], input: string): Target {
  const segments = splitPath(input)
  if (segments.length === 0) throw new ToolError(`Укажи путь вида папка/файл. Папки: ${folders.map((f) => f.name).join(', ')}`)
  const [head, ...rest] = segments
  const folder = folders.find((f) => f.name === head) ?? folders.find((f) => f.name.toLowerCase() === head!.toLowerCase())
  if (!folder) throw new ToolError(`Нет папки «${head}». Доступны: ${folders.map((f) => f.name).join(', ')}`)
  return { folder, abs: path.join(folder.root, ...rest), shown: [folder.name, ...rest].join('/'), isRoot: rest.length === 0 }
}

async function realOrAncestor(abs: string): Promise<string> {
  let cur = abs
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...tail.reverse())
    } catch (e) {
      if (code(e) !== 'ENOENT' && code(e) !== 'ENOTDIR') throw e
      const parent = path.dirname(cur)
      if (parent === cur) throw e
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

/** Resolve and check that symlinks do not lead outside the folder. */
export async function resolveTarget(folders: Folder[], input: string, need: Access): Promise<Target> {
  const t = target(folders, input)
  requireAccess(t.folder, need)
  let rootReal: string
  try {
    rootReal = await fs.realpath(t.folder.root)
  } catch (e) {
    throw new ToolError(`Папка «${t.folder.name}» недоступна: ${fsMessage(e, t.folder.name)}`)
  }
  const real = await realOrAncestor(t.abs)
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new ToolError(`«${t.shown}» ведёт за пределы папки «${t.folder.name}» (символьная ссылка)`)
  return t
}

// ---------------------------------------------------------------------------
// Errors

export function code(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined
}

export function fsMessage(e: unknown, shown: string): string {
  switch (code(e)) {
    case 'ENOENT':
      return `«${shown}» не найден`
    case 'EEXIST':
      return `«${shown}» уже существует`
    case 'ENOTDIR':
      return `«${shown}» — не папка`
    case 'EISDIR':
      return `«${shown}» — папка, а не файл`
    case 'ENOTEMPTY':
      return `папка «${shown}» не пуста`
    case 'EACCES':
    case 'EPERM':
      return `нет прав на «${shown}» у пользователя контейнера — проверь владельца папки или PUID/PGID`
    case 'EROFS':
      return `«${shown}» смонтирован только для чтения (:ro в volumes)`
    case 'ENOSPC':
      return 'на диске нет места'
    default:
      return e instanceof Error ? e.message : String(e)
  }
}

/** Run a filesystem call; known errors become short messages for the model. */
export async function fsCall<T>(shown: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ToolError) throw e
    if (code(e)) throw new ToolError(fsMessage(e, shown))
    throw e
  }
}
