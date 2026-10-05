import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { folderList, resolveTarget } from './folders'

const TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

// Shown in the browser; everything else (HTML and SVG included) downloads.
const INLINE = /^(application\/pdf|image\/(png|jpeg|gif|webp)|video\/|audio\/|text\/plain)/

function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** «bytes=start-end» → a single satisfiable range, or null to send the whole file. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (!m[1] && !m[2])) return null
  let start: number
  let end: number
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

export type FileResponse = { status: number; body: ReadableStream | null; headers: Record<string, string> }

/**
 * A file for /f/{token}. The stored path is resolved against the current folder settings,
 * so a folder removed or a path that now escapes it stops working. Throws ToolError.
 */
export async function openFile(folders: string, shown: string, range: string | null): Promise<FileResponse> {
  const t = await resolveTarget(folderList(folders), shown, 'read')
  const st = await fs.stat(t.abs)
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' })
  const type = TYPES[path.extname(t.abs).toLowerCase()] ?? 'application/octet-stream'
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Disposition': disposition(INLINE.test(type) ? 'inline' : 'attachment', path.basename(t.abs)),
    'Accept-Ranges': 'bytes',
    'Last-Modified': st.mtime.toUTCString(),
  }
  const r = parseRange(range, st.size)
  if (r === 'invalid') return { status: 416, body: null, headers: { ...headers, 'Content-Range': `bytes */${st.size}` } }
  const { start, end } = r ?? { start: 0, end: st.size - 1 }
  const length = st.size === 0 ? 0 : end - start + 1
  const body = length === 0 ? null : (Readable.toWeb(createReadStream(t.abs, { start, end })) as ReadableStream)
  return {
    status: r ? 206 : 200,
    body,
    headers: { ...headers, 'Content-Length': String(length), ...(r ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}) },
  }
}
