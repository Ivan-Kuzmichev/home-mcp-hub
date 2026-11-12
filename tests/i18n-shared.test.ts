import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { runWithLang } = await import('@/lib/i18n')
const { serviceFetch } = await import('@/lib/connectors/http')
const { rpc } = await import('@/lib/mcp/inspect')
const route = await import('@/app/f/[token]/route')

afterAll(cleanup)
afterEach(() => vi.unstubAllGlobals())

describe('shared texts in English', () => {
  it('service errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }))))
    await expect(runWithLang('en', () => serviceFetch('Jackett', 'http://jackett:9117/'))).rejects.toThrow('Jackett is unreachable: connection refused')
    await expect(runWithLang('ru', () => serviceFetch('Jackett', 'http://jackett:9117/'))).rejects.toThrow('Jackett недоступен: соединение отклонено')
  })

  it('hub tools speak the hub language', async () => {
    const { tools } = await runWithLang('en', () => rpc<{ tools: { name: string; title?: string; description?: string }[] }>('tools/list'))
    expect(tools.find((x) => x.name === 'hub_status')).toMatchObject({ title: 'Hub status' })
    const status = await runWithLang('en', () => rpc<{ content: { text: string }[] }>('tools/call', { name: 'hub_status', arguments: {} }))
    expect(status.content[0]!.text).toMatch(/^Home Hub v\S+ · uptime \d+ min/)
    const ru = await runWithLang('ru', () => rpc<{ content: { text: string }[] }>('tools/call', { name: 'hub_status', arguments: {} }))
    expect(ru.content[0]!.text).toMatch(/^Home Hub v\S+ · аптайм \d+ мин/)
  })

  it('instructions follow the language', async () => {
    const { buildInstructions } = await import('@/lib/mcp/server')
    expect(runWithLang('en', () => buildInstructions())).toMatch(/^Home Hub is the user's home hub\. Keep answers short/)
    expect(runWithLang('ru', () => buildInstructions())).toMatch(/^Home Hub — домашний хаб пользователя\. Отвечай коротко/)
  })

  it('download link pages', async () => {
    const ctx = (token: string) => ({ params: Promise.resolve({ token }) })
    const res = await runWithLang('en', () => route.GET(new Request('https://hub.example.com/f/x'), ctx('x'.repeat(32))))
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('Link not found')
  })
})
