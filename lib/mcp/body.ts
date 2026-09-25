import zlib from 'node:zlib'
import { logger } from '../logger'

/** Upper bound after decompression: prototypes are ≤ 5 MB, JSON escaping can triple that. */
export const MAX_DECODED_BODY = 16 * 1024 * 1024

export class BodyError extends Error {}

function decode(encoding: string, data: Buffer): Buffer {
  const opts = { maxOutputLength: MAX_DECODED_BODY }
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(data, opts)
    case 'deflate':
      // «deflate» in HTTP is zlib-wrapped, but some clients send raw deflate.
      try {
        return zlib.inflateSync(data, opts)
      } catch {
        return zlib.inflateRawSync(data, opts)
      }
    case 'br':
      return zlib.brotliDecompressSync(data, opts)
    case 'zstd': {
      const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer, o: object) => Buffer }).zstdDecompressSync
      if (!zstd) throw new BodyError('zstd is not supported by this Node version')
      return zstd(data, opts)
    }
    default:
      throw new BodyError(`Unsupported Content-Encoding: ${encoding}`)
  }
}

/**
 * Next.js does not decompress request bodies. MCP clients (Claude among them) gzip large
 * requests, which the SDK then fails to parse as JSON. Decode here and hand the SDK plain JSON.
 */
export async function decodeRequestBody(req: Request): Promise<Request> {
  const encodings = (req.headers.get('content-encoding') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && e !== 'identity')
  if (encodings.length === 0 || req.method !== 'POST') return req

  let body: Buffer = Buffer.from(await req.arrayBuffer())
  const compressed = body.length
  // Encodings are listed in the order they were applied: undo from the last one.
  for (const enc of encodings.reverse()) body = decode(enc, body)

  const headers = new Headers(req.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  logger.debug({ encodings, compressed, decoded: body.length }, 'mcp request body decoded')
  return new Request(req.url, { method: req.method, headers, body: new Uint8Array(body), signal: req.signal })
}

/** When the SDK still cannot parse the body, log what arrived — sizes and encodings, never content. */
export async function logUnparsableBody(req: Request): Promise<void> {
  try {
    const text = await req.clone().text()
    JSON.parse(text)
  } catch {
    logger.warn(
      {
        contentType: req.headers.get('content-type'),
        contentLength: req.headers.get('content-length'),
        transferEncoding: req.headers.get('transfer-encoding'),
        received: (await req.clone().arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength,
      },
      'mcp request body is not valid JSON',
    )
  }
}
