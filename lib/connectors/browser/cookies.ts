import fs from 'node:fs/promises'
import { folderList, fsMessage, resolveTarget } from '../files/folders'
import { ToolError } from '../types'

export const MAX_COOKIES = 500
export const MAX_COOKIE_FILE_BYTES = 5 * 1024 * 1024

export type Cookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean }

/** Netscape cookies.txt (browser extensions, yt-dlp): 7 tab-separated columns, `#HttpOnly_` prefix. */
export function parseNetscapeCookies(text: string): Cookie[] {
  const cookies: Cookie[] = []
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    let line = raw.trim()
    if (!line) continue
    const httpOnly = line.startsWith('#HttpOnly_')
    if (httpOnly) line = line.slice('#HttpOnly_'.length)
    else if (line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const expires = Number(parts[4])
    cookies.push({
      domain: parts[0]!,
      path: parts[2] || '/',
      secure: parts[3]!.toUpperCase() === 'TRUE',
      // 0 means a session cookie; Playwright spells that -1 and would drop 0 as expired in 1970.
      expires: Number.isFinite(expires) && expires > 0 ? expires : -1,
      name: parts[5]!,
      value: parts.slice(6).join('\t'),
      httpOnly,
    })
  }
  return cookies
}

/**
 * Read a cookies file through the Files connector: «папка/cookies/…» only, so the model
 * cannot feed arbitrary files of the user to the browser.
 */
export async function readCookieFile(input: string): Promise<{ text: string; shown: string }> {
  // Lazy: active → registry → this connector would be an import cycle.
  const { activeConfig } = await import('../active')
  const files = activeConfig('files') as { folders?: string } | null
  if (!files) throw new ToolError('Файлы cookies берутся из коннектора «Файлы» — включи его и добавь папку')
  const t = await resolveTarget(folderList(files.folders ?? ''), input, 'read')
  const inside = t.shown.split('/').slice(1)
  if (inside[0] !== 'cookies' || inside.length < 2) throw new ToolError(`Cookies читаются только из подпапки cookies/: ${t.folder.name}/cookies/<файл>`)
  try {
    const stat = await fs.stat(t.abs)
    if (!stat.isFile()) throw new ToolError(`«${t.shown}» — не файл`)
    if (stat.size > MAX_COOKIE_FILE_BYTES) throw new ToolError(`«${t.shown}» больше ${MAX_COOKIE_FILE_BYTES / 1024 / 1024} МБ`)
    return { text: await fs.readFile(t.abs, 'utf8'), shown: t.shown }
  } catch (e) {
    if (e instanceof ToolError) throw e
    throw new ToolError(fsMessage(e, t.shown))
  }
}
