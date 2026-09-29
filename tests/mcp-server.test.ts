import { afterAll, describe, expect, it } from 'vitest'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { buildInstructions } = await import('@/lib/mcp/server')
const { saveConfig, setDisabledTools, setInstructions } = await import('@/lib/connectors/store')
const { rpc, inspectMcp } = await import('@/lib/mcp/inspect')
const { getConnector } = await import('@/lib/connectors/registry')
saveConfig(getConnector('prototypes')!, {})

afterAll(cleanup)

describe('MCP server', () => {
  it('reports its title, version and logo on initialize', async () => {
    const result = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    const info = result.serverInfo as { name: string; title: string; icons: { src: string; mimeType: string }[] }
    expect(info).toMatchObject({ name: 'home-mcp-hub', title: 'Home Hub' })
    expect(info.icons[0]).toMatchObject({ mimeType: 'image/svg+xml' })
    expect(Buffer.from(info.icons[0]!.src.split(',')[1]!, 'base64').toString()).toContain('<svg')
    expect(result.instructions).toContain('prototype_append')
  })

  it('builds instructions only from connectors that are on, with user notes', () => {
    const before = buildInstructions()
    expect(before).toContain('Подключено: Прототипы')
    expect(before).not.toContain('transmission_add')
    expect(before).not.toContain('Paperless')
    expect(before).not.toContain('search_torrents')

    saveConfig(getConnector('jackett')!, { baseUrl: 'http://jackett:9117', apiKey: 'k', minSeeders: 1 })
    saveConfig(getConnector('torrserve')!, { baseUrl: 'http://torrserve:8090', authMode: 'none', saveToDb: true })
    setInstructions('torrserve', 'append', 'Постер бери с TMDB')
    saveConfig(getConnector('paperless')!, { baseUrl: 'http://paperless:8000', apiToken: 't', excludeTag: 'private', removeInbox: true, rules: '- тег «жкх» для квитанций' })
    const after = buildInstructions()
    expect(after).toContain('потом torrserve_add (TorrServe — смотреть без скачивания) с result_id')
    expect(after).not.toContain('torrent_add (qBittorrent)')
    expect(after).not.toContain('transmission_add')
    expect(after).toContain('TorrServe: смотреть без скачивания — torrserve_add, ссылки для плеера — torrserve_links.\nПостер бери с TMDB')
    // Labeling rules come with the Paperless reads, not with every chat.
    expect(after).not.toContain('тег «жкх»')
    expect(after).toContain('правила разметки — они приходят в ответах paperless_review')
  })

  it('drops lines about switched-off tools and honours «replace»', () => {
    saveConfig(getConnector('scripts')!, {})
    setDisabledTools('scripts', ['cron_create', 'cron_update'])
    expect(buildInstructions()).toContain('Cron-скрипты: можно смотреть и запускать существующие')
    expect(buildInstructions()).not.toContain('cron_create')

    setInstructions('torrserve', 'replace', 'Только своё')
    const text = buildInstructions()
    expect(text).toContain('\nТолько своё\n')
    expect(text).not.toContain('ссылки для плеера')

    setInstructions('torrserve', 'replace', null)
    expect(buildInstructions()).not.toContain('TorrServe:')
  })

  it('shows diagnostics exactly as a client sees them', async () => {
    const snap = await inspectMcp()
    expect(snap.instructions).toBe(buildInstructions())
    expect(snap.tools.map((t) => t.name)).toContain('hub_status')
    expect(snap.tools.map((t) => t.name)).not.toContain('cron_create')
    expect(snap.parts.find((p) => p.connector === 'TorrServe')).toMatchObject({ mode: 'replace', text: null })
  })
})

describe('custom MCP tools', () => {
  it('appear in tools/list once approved and are called like any tool', async () => {
    const store = await import('@/lib/scripts/store')
    const s = await store.createTool({ name: 'greet', description: 'Здоровается', params: [{ name: 'who', type: 'string', description: '', required: true }], readOnly: true, code: `return 'привет, ' + args.who` })
    const names = async () => (await rpc<{ tools: { name: string }[] }>('tools/list')).tools.map((t) => t.name)
    expect(await names()).not.toContain('my_greet')

    store.approveScript(s.id, s.codeHash)
    const tools = (await rpc<{ tools: { name: string; inputSchema: { required?: string[] }; annotations?: { readOnlyHint?: boolean } }[] }>('tools/list')).tools
    const greet = tools.find((t) => t.name === 'my_greet')
    expect(greet).toMatchObject({ inputSchema: { required: ['who'] }, annotations: { readOnlyHint: true } })

    const called = await rpc<{ content: { text: string }[] }>('tools/call', { name: 'my_greet', arguments: { who: 'Ваня' } })
    expect(called.content[0]!.text).toBe('привет, Ваня')
  })
})

describe('ChatGPT account linking', () => {
  it('every tool declares the oauth2 security scheme', async () => {
    const { tools } = await rpc<{ tools: { name: string; _meta?: { securitySchemes?: unknown } }[] }>('tools/list')
    expect(tools.length).toBeGreaterThan(1)
    for (const t of tools) expect(t._meta?.securitySchemes, t.name).toEqual([{ type: 'oauth2', scopes: ['hub'] }])
  })
})
