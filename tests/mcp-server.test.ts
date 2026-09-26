import { afterAll, describe, expect, it } from 'vitest'
import { setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { getMcpHandler } = await import('@/lib/mcp/server')

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
})
