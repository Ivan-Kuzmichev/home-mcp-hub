import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeRequestBody, describeUnparsableBody, MAX_DECODED_BODY } from '@/lib/mcp/body'

const json = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { html: 'Съешь же ещё этих булок '.repeat(3000) } })
const post = (body: Uint8Array, encoding?: string) =>
  new Request('http://hub/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(encoding ? { 'content-encoding': encoding } : {}) }, body: new Uint8Array(body) })

describe('MCP request body decoding', () => {
  it.each([
    ['gzip', zlib.gzipSync(json)],
    ['deflate', zlib.deflateSync(json)],
    ['deflate (raw)', zlib.deflateRawSync(json)],
    ['br', zlib.brotliCompressSync(json)],
  ])('decodes %s', async (name, data) => {
    const { request } = await decodeRequestBody(post(new Uint8Array(data), name.split(' ')[0]))
    expect(request.headers.get('content-encoding')).toBeNull()
    expect(JSON.parse(await request.text())).toEqual(JSON.parse(json))
  })

  it('passes plain bodies through and describes broken ones without content', async () => {
    const plain = await decodeRequestBody(post(new TextEncoder().encode(json)))
    expect(await plain.request.text()).toBe(json)
    const original = post(new TextEncoder().encode(json))
    expect(describeUnparsableBody(original, plain)).toBeNull()

    const cut = json.slice(0, 5000)
    const broken = await decodeRequestBody(post(new TextEncoder().encode(cut)))
    const info = describeUnparsableBody(post(new TextEncoder().encode(cut)), broken)!
    expect(info).toMatchObject({ decodedBytes: Buffer.byteLength(cut), endsWithBrace: false, head: Buffer.from(cut.slice(0, 8)).toString('hex') })
    expect(String(info.jsonError)).toMatch(/JSON|Unterminated|end/i)
    expect(JSON.stringify(info)).not.toContain('булок')
  })

  it('refuses decompression bombs and unknown encodings', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(MAX_DECODED_BODY + 1024))
    await expect(decodeRequestBody(post(new Uint8Array(bomb), 'gzip'))).rejects.toThrow()
    await expect(decodeRequestBody(post(new Uint8Array([1, 2, 3]), 'compress'))).rejects.toThrow('Unsupported')
  })
})
