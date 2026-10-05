import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { files } from '@/lib/connectors/files'
import { parseFolders } from '@/lib/connectors/files/folders'
import { configOf, runTool, runToolRaw } from './helpers'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-files-'))
const dir = (name: string) => path.join(tmp, name)
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-outside-'))

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

beforeEach(() => {
  for (const name of ['ro', 'add', 'edit', 'full']) {
    fs.rmSync(dir(name), { recursive: true, force: true })
    fs.mkdirSync(dir(name), { recursive: true })
  }
  fs.mkdirSync(path.join(dir('ro'), 'notes'))
  fs.writeFileSync(path.join(dir('ro'), 'notes', 'todo.md'), 'купить молоко\nпочинить кран\n')
  fs.writeFileSync(path.join(dir('ro'), 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(dir('ro'), 'blob.bin'), Buffer.from([1, 0, 2, 0]))
  fs.writeFileSync(path.join(dir('add'), 'old.txt'), 'old')
  fs.writeFileSync(path.join(dir('edit'), 'a.txt'), 'one two two')
  fs.writeFileSync(path.join(dir('full'), 'x.txt'), 'x')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret')
})

const cfg = configOf(files, {
  folders: [`Архив | ${dir('ro')}`, `Входящие | ${dir('add')} | add`, `${dir('edit')} | edit`, `full | ${dir('full')} | full`].join('\n'),
})
const run = (name: string, args: Record<string, unknown>) => runTool(files, name, cfg, args)

describe('folder list', () => {
  it('parses names, modes and defaults', () => {
    const r = parseFolders(`# comment\n/files/docs\nФото | /files/photos/ | rw\n/files/in | add`)
    expect(r).toEqual({
      ok: true,
      folders: [
        { name: 'docs', root: '/files/docs', access: 'read' },
        { name: 'Фото', root: '/files/photos', access: 'edit' },
        { name: 'in', root: '/files/in', access: 'add' },
      ],
    })
  })

  it('rejects relative paths, the container root, unknown modes and duplicates', () => {
    expect(parseFolders('docs | files/docs')).toMatchObject({ ok: false, error: expect.stringContaining('абсолютным') })
    expect(parseFolders('all | /')).toMatchObject({ ok: false, error: expect.stringContaining('корень') })
    expect(parseFolders('/files/docs | write')).toMatchObject({ ok: false, error: expect.stringContaining('режим') })
    expect(parseFolders('/a/docs\n/b/docs')).toMatchObject({ ok: false, error: expect.stringContaining('Строка 2') })
    expect(files.parseConfig({ folders: '' })).toMatchObject({ ok: false, errors: { folders: expect.any(String) } })
  })

  it('test() reports every folder and fails on a missing mount', async () => {
    expect(await files.test(cfg)).toMatchObject({ ok: true, summary: '4 папки' })
    const broken = configOf(files, { folders: `${dir('ro')}\n${path.join(tmp, 'nope')}` })
    expect(await files.test(broken)).toMatchObject({ ok: false, summary: expect.stringContaining('смонтируй') })
  })

  it('instructions list folders with their access', () => {
    const text = files.instructions!(cfg, { tools: files.tools.map((t) => t.name) })
    expect(text).toContain('Архив — только чтение')
    expect(text).toContain('Входящие — чтение и добавление')
    expect(text).toContain('files_edit')
    // The connector form renders instructions before anything is saved.
    expect(files.instructions!({}, { tools: ['files_list'] })).toBeNull()
  })
})

describe('reading', () => {
  it('lists folders, directories with depth and file info', async () => {
    expect(await run('files_list', {})).toContain('• Входящие/ — чтение и добавление')
    const tree = await run('files_list', { path: 'архив', depth: 2 })
    expect(tree).toContain('• notes/')
    expect(tree).toContain('   • todo.md — ')
    expect(await run('files_list', { path: 'Архив/notes/todo.md' })).toContain('Архив/notes/todo.md')
  })

  it('reads text by lines, images as images, refuses binaries', async () => {
    const text = await run('files_read', { path: 'Архив/notes/todo.md', offset: 2, limit: 1 })
    expect(text).toContain('починить кран')
    expect(text).not.toContain('купить')
    expect(text).toContain('строки 2–2')
    const img = await runToolRaw(files, 'files_read', cfg, { path: 'Архив/photo.png' })
    expect(img).toMatchObject({ images: [{ mimeType: 'image/png' }] })
    expect(await run('files_read', { path: 'Архив/blob.bin' })).toContain('двоичный')
  })

  it('searches by mask and by text', async () => {
    expect(await run('files_search', { name: '*.md' })).toContain('Архив/notes/todo.md')
    expect(await run('files_search', { text: 'КРАН' })).toContain('Архив/notes/todo.md — строка 2: починить кран')
  })

  it('never leaves the folder: .., symlinks, unknown folders', async () => {
    await expect(run('files_read', { path: 'Архив/../edit/a.txt' })).rejects.toThrow('«..»')
    fs.symlinkSync(outside, path.join(dir('ro'), 'escape'))
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir('ro'), 'secret.txt'))
    await expect(run('files_read', { path: 'Архив/escape/secret.txt' })).rejects.toThrow('за пределы')
    await expect(run('files_read', { path: 'Архив/secret.txt' })).rejects.toThrow('за пределы')
    await expect(run('files_read', { path: 'etc/passwd' })).rejects.toThrow('Нет папки «etc»')
  })
})

describe('access modes', () => {
  it('read: nothing changes', async () => {
    await expect(run('files_write', { path: 'Архив/new.txt', content: 'x' })).rejects.toThrow('только чтение')
    await expect(run('files_mkdir', { path: 'Архив/sub' })).rejects.toThrow('только чтение')
  })

  it('add: new files and chunked appends to them, existing files stay as they are', async () => {
    expect(await run('files_write', { path: 'Входящие/sub/new.txt', content: 'a' })).toContain('Создан Входящие/sub/new.txt')
    expect(await run('files_write', { path: 'Входящие/sub/new.txt', content: 'b', mode: 'append' })).toContain('Дописан')
    expect(fs.readFileSync(path.join(dir('add'), 'sub', 'new.txt'), 'utf8')).toBe('ab')
    await expect(run('files_write', { path: 'Входящие/old.txt', content: 'x', mode: 'overwrite' })).rejects.toThrow('правки')
    await expect(run('files_write', { path: 'Входящие/old.txt', content: 'x', mode: 'append' })).rejects.toThrow('правки')
    await expect(run('files_write', { path: 'Входящие/old.txt', content: 'x' })).rejects.toThrow('уже есть')
    await expect(run('files_move', { from: 'Входящие/old.txt', to: 'Входящие/renamed.txt' })).rejects.toThrow('правки')
  })

  it('edit: overwrite, replace text, move, but no delete', async () => {
    await run('files_write', { path: 'edit/a.txt', content: 'one two two', mode: 'overwrite' })
    await expect(run('files_edit', { path: 'edit/a.txt', old_text: 'two', new_text: '2' })).rejects.toThrow('2 раз')
    expect(await run('files_edit', { path: 'edit/a.txt', old_text: 'two', new_text: '2', all: true })).toContain('2 замены')
    expect(fs.readFileSync(path.join(dir('edit'), 'a.txt'), 'utf8')).toBe('one 2 2')
    await run('files_mkdir', { path: 'edit/docs' })
    expect(await run('files_move', { from: 'edit/a.txt', to: 'edit/docs' })).toBe('Перемещено: edit/a.txt → edit/docs/a.txt')
    await expect(run('files_delete', { path: 'edit/docs/a.txt', confirm: true })).rejects.toThrow('удаления')
  })

  it('copy between folders needs read on the source and add on the target', async () => {
    expect(await run('files_copy', { from: 'Архив/notes', to: 'Входящие' })).toBe('Скопировано: Архив/notes → Входящие/notes')
    expect(fs.readFileSync(path.join(dir('add'), 'notes', 'todo.md'), 'utf8')).toContain('кран')
    await expect(run('files_copy', { from: 'Архив/notes', to: 'Входящие' })).rejects.toThrow('уже существует')
    await expect(run('files_copy', { from: 'edit/a.txt', to: 'Архив' })).rejects.toThrow('только чтение')
    await expect(run('files_move', { from: 'Архив/notes/todo.md', to: 'edit' })).rejects.toThrow('только чтение')
  })

  it('full: delete asks for confirm first, never the folder itself', async () => {
    expect(await run('files_delete', { path: 'full/x.txt' })).toContain('Не удалено')
    expect(fs.existsSync(path.join(dir('full'), 'x.txt'))).toBe(true)
    expect(await run('files_delete', { path: 'full/x.txt', confirm: true })).toContain('Удалено: файл full/x.txt')
    expect(fs.existsSync(path.join(dir('full'), 'x.txt'))).toBe(false)
    await expect(run('files_delete', { path: 'full', confirm: true })).rejects.toThrow('Саму папку')
  })
})
