import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { configOf, runTool, setupTempDb } from './helpers'

const cleanup = await setupTempDb()
process.env.BASE_URL = 'https://hub.example.com'
const { files } = await import('@/lib/connectors/files')
const { parseRange } = await import('@/lib/connectors/files/download')
const { saveConfig } = await import('@/lib/connectors/store')
const route = await import('@/app/f/[token]/route')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-links-'))
afterAll(() => {
  cleanup()
  fs.rmSync(root, { recursive: true, force: true })
})

fs.mkdirSync(path.join(root, 'docs', 'sub'), { recursive: true })
fs.writeFileSync(path.join(root, 'docs', 'sub', 'счёт.pdf'), '%PDF-1.7 hello')
fs.writeFileSync(path.join(root, 'docs', 'page.html'), '<script>alert(1)</script>')

const raw = { folders: `Документы | ${path.join(root, 'docs')}` }
const cfg = configOf(files, raw)
saveConfig(files, cfg as Record<string, unknown>)

const tokenOf = (text: string) => text.match(/\/f\/([A-Za-z0-9_-]{32})/)![1]!
const get = (token: string, headers: Record<string, string> = {}) =>
  route.GET(new Request(`https://hub.example.com/f/${token}`, { headers }), { params: Promise.resolve({ token }) })

describe('files_link and /f/{token}', () => {
  it('a shareable link streams the file once, inline for PDFs, with a UTF-8 name', async () => {
    const text = await runTool(files, 'files_link', cfg, { path: 'Документы/sub/счёт.pdf', shareable: true })
    expect(text).toContain('https://hub.example.com/f/')
    expect(text).not.toContain(root)
    const token = tokenOf(text)
    const res = await get(token, { range: 'bytes=0-3' })
    // One-time links ignore Range: a player's second request would find the link used.
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe(`inline; filename="____.pdf"; filename*=UTF-8''${encodeURIComponent('счёт.pdf')}`)
    expect(res.headers.get('content-security-policy')).toBe('sandbox')
    expect(await res.text()).toBe('%PDF-1.7 hello')
    expect((await get(token)).status).toBe(410)
  })

  it('HTML downloads instead of rendering', async () => {
    const res = await get(tokenOf(await runTool(files, 'files_link', cfg, { path: 'Документы/page.html', shareable: true })))
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/)
  })

  it('stops working when the file or the folder is gone', async () => {
    fs.writeFileSync(path.join(root, 'docs', 'tmp.txt'), 'x')
    const t1 = tokenOf(await runTool(files, 'files_link', cfg, { path: 'Документы/tmp.txt', shareable: true }))
    fs.rmSync(path.join(root, 'docs', 'tmp.txt'))
    expect((await get(t1)).status).toBe(404)

    const t2 = tokenOf(await runTool(files, 'files_link', cfg, { path: 'Документы/sub/счёт.pdf', shareable: true }))
    saveConfig(files, configOf(files, { folders: `Другое | ${path.join(root, 'docs', 'sub')}` }) as Record<string, unknown>)
    expect((await get(t2)).status).toBe(404)
    saveConfig(files, cfg as Record<string, unknown>)
  })

  it('refuses folders', async () => {
    await expect(runTool(files, 'files_link', cfg, { path: 'Документы/sub' })).rejects.toThrow('папка')
  })

  it('parses byte ranges', () => {
    expect(parseRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 })
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 })
    expect(parseRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 })
    expect(parseRange('bytes=20-', 10)).toBe('invalid')
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull()
    expect(parseRange(null, 10)).toBeNull()
  })
})
