import { t, tr, trc } from '../../i18n'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ToolError } from '../types'
import { deniedSegment, denyMatcher, parseDeny, type DenyMatcher } from './deny'

// ---------------------------------------------------------------------------
// Folders from the connector settings: one per line, «name | /path | mode».

export const ACCESS = ['read', 'add', 'edit', 'full'] as const
export type Access = (typeof ACCESS)[number]

/** English; shown through tr(). */
export const ACCESS_LABEL: Record<Access, string> = {
  read: 'read only',
  add: 'read and add',
  edit: 'read and edit',
  full: 'full access',
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

/** `deny`: closed names from the connector settings (see deny.ts), checked on every path. */
export type Folder = { name: string; root: string; access: Access; deny?: DenyMatcher }

const NAME = /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u

/** Parse the folders text; returns the folders or the first error (line number included). */
export function parseFolders(text: string): { ok: true; folders: Folder[] } | { ok: false; error: string } {
  const folders: Folder[] = []
  const lines = text.split('\n')
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const fail = (msg: string) => ({ ok: false as const, error: t`Line ${i + 1}: ${msg}` })
    const parts = line.split('|').map((p) => p.trim())
    if (parts.length > 3) return fail(t`expected “name | /path | mode”`)
    // «/path», «/path | mode», «name | /path», «name | /path | mode»
    const hasName = !parts[0]!.startsWith('/')
    const name = hasName ? parts[0]! : path.posix.basename(parts[0]!)
    const root = hasName ? parts[1] : parts[0]
    const mode = (hasName ? parts[2] : parts[1]) ?? 'read'
    if (!root) return fail(t`no folder path`)
    if (!root.startsWith('/')) return fail(t`the path “${root}” must be absolute — as in the container volumes`)
    if (path.posix.normalize(root) === '/') return fail(t`the container root cannot be opened`)
    if (!NAME.test(name)) return fail(t`name “${name}” — letters, digits, space, dot, hyphen`)
    const access = ACCESS_ALIASES[mode.toLowerCase()]
    if (!access) return fail(t`mode “${mode}” — read, add, edit or full`)
    if (folders.some((f) => f.name.toLowerCase() === name.toLowerCase())) return fail(t`the name “${name}” is taken — set another: “name | ${root}”`)
    folders.push({ name, root: path.posix.normalize(root).replace(/\/+$/, ''), access })
  }
  if (folders.length === 0) return { ok: false, error: t`Add at least one folder` }
  return { ok: true, folders }
}

export function folderList(text: string, denyText?: string): Folder[] {
  const r = parseFolders(text)
  if (!r.ok) throw new ToolError(t`The folder list in the connector settings has an error: ${r.error}`)
  const deny = denyMatcher(parseDeny(denyText))
  return r.folders.map((f) => ({ ...f, deny }))
}

export function allows(f: Folder, need: Access): boolean {
  return ACCESS.indexOf(f.access) >= ACCESS.indexOf(need)
}

/** English; shown through trc('need', …): the Russian is in the genitive («для правки»). */
const NEED_TEXT: Record<Access, string> = {
  read: 'reading',
  add: 'adding files',
  edit: 'editing',
  full: 'deleting',
}

export function requireAccess(f: Folder, need: Access): void {
  if (!allows(f, need)) throw new ToolError(t`Folder “${f.name}” is open as “${tr(ACCESS_LABEL[f.access])}” — ${trc('need', NEED_TEXT[need])} needs higher access. It is changed in the hub admin panel.`)
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
  if (input.includes('\0')) throw new ToolError(t`Invalid character in the path`)
  const segments = input.split(/[\\/]+/).filter((s) => s && s !== '.')
  if (segments.includes('..')) throw new ToolError(t`“..” is not allowed in a path — give the path from the folder: folder/subfolder/file`)
  return segments
}

export function target(folders: Folder[], input: string): Target {
  const segments = splitPath(input)
  if (segments.length === 0) throw new ToolError(t`Give a path like folder/file. Folders: ${folders.map((f) => f.name).join(', ')}`)
  const [head, ...rest] = segments
  const folder = folders.find((f) => f.name === head) ?? folders.find((f) => f.name.toLowerCase() === head!.toLowerCase())
  if (!folder) throw new ToolError(t`No folder “${head}”. Available: ${folders.map((f) => f.name).join(', ')}`)
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
  const item = target(folders, input)
  const closed = deniedSegment(item.shown.split('/').slice(1), item.folder.deny)
  if (closed) throw new ToolError(t`“${item.shown}” is closed: “${closed}” is in the forbidden files of the Files connector`)
  requireAccess(item.folder, need)
  let rootReal: string
  try {
    rootReal = await fs.realpath(item.folder.root)
  } catch (e) {
    throw new ToolError(t`Folder “${item.folder.name}” is unavailable: ${fsMessage(e, item.folder.name)}`)
  }
  const real = await realOrAncestor(item.abs)
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new ToolError(t`“${item.shown}” leads outside the folder “${item.folder.name}” (symbolic link)`)
  return item
}

// ---------------------------------------------------------------------------
// Errors

export function code(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined
}

export function fsMessage(e: unknown, shown: string): string {
  switch (code(e)) {
    case 'ENOENT':
      return t`“${shown}” not found`
    case 'EEXIST':
      return t`“${shown}” already exists`
    case 'ENOTDIR':
      return t`“${shown}” is not a folder`
    case 'EISDIR':
      return t`“${shown}” is a folder, not a file`
    case 'ENOTEMPTY':
      return t`folder “${shown}” is not empty`
    case 'EACCES':
    case 'EPERM':
      return t`the container user has no rights to “${shown}” — check the folder owner or PUID/PGID`
    case 'EROFS':
      return t`“${shown}” is mounted read-only (:ro in volumes)`
    case 'ENOSPC':
      return t`no space left on the disk`
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
