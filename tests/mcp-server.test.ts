import { afterAll, describe, expect, it } from 'vitest'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { getMcpHandler, buildInstructions } = await import('@/lib/mcp/server')
const { saveConfig } = await import('@/lib/connectors/store')
const { getConnector } = await import('@/lib/connectors/registry')
saveConfig(getConnector('prototypes')!, {})

afterAll(cleanup)

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await getMcpHandler()(
    new Request('http://hub/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  const text = await res.text()
  const json = text.includes('data: ') ? text.split('data: ')[1]!.split('\n')[0]! : text
  return JSON.parse(json) as { result: Record<string, unknown> }
}

describe('MCP server', () => {
  it('reports its title, version and logo on initialize', async () => {
    const { result } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
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
    saveConfig(getConnector('torrserve')!, { baseUrl: 'http://torrserve:8090', authMode: 'none', saveToDb: true, instructions: 'Постер бери с TMDB' })
    saveConfig(getConnector('paperless')!, { baseUrl: 'http://paperless:8000', apiToken: 't', excludeTag: 'private', removeInbox: true, rules: '- тег «жкх» для квитанций' })
    const after = buildInstructions()
    expect(after).toContain('потом torrserve_add (TorrServe — смотреть без скачивания) с result_id')
    expect(after).not.toContain('torrent_add (qBittorrent)')
    expect(after).not.toContain('transmission_add')
    expect(after).toContain('Инструкции пользователя для TorrServe:\nПостер бери с TMDB')
    expect(after).toContain('Правила разметки Paperless от пользователя — соблюдай при любой правке документов:\n- тег «жкх» для квитанций')
  })
})
