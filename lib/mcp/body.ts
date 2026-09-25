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

export type DecodedBody = { request: Request; raw: number; decoded: Buffer; encodings: string[] }

/**
 * Reads the body once, undoes Content-Encoding (Next.js does not decompress request bodies,
 * MCP clients gzip large requests) and returns a fresh Request with plain JSON for the SDK.
 */
export async function decodeRequestBody(req: Request): Promise<DecodedBody> {
  const encodings = (req.headers.get('content-encoding') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && e !== 'identity')
  const rawBuf: Buffer = Buffer.from(await req.arrayBuffer())
  let body: Buffer = rawBuf
  // Encodings are listed in the order they were applied: undo from the last one.
  for (const enc of [...encodings].reverse()) body = decode(enc, body)

  const headers = new Headers(req.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  const request = new Request(req.url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(body), signal: req.signal })
  return { request, raw: rawBuf.length, decoded: body, encodings }
}

/** Why the SDK could not parse a body — sizes, encodings and the JSON error, never the content. */
export function describeUnparsableBody(original: Request, body: DecodedBody): Record<string, unknown> | null {
  const text = body.decoded.toString('utf8')
  try {
    JSON.parse(text)
    return null
  } catch (error) {
    return {
      jsonError: error instanceof Error ? error.message.slice(0, 160) : String(error),
      contentType: original.headers.get('content-type'),
      contentLength: original.headers.get('content-length'),
      contentEncoding: body.encodings.join(',') || null,
      transferEncoding: original.headers.get('transfer-encoding'),
      rawBytes: body.raw,
      decodedBytes: body.decoded.length,
      // First bytes as hex: tells gzip/zstd/binary from JSON without logging content.
      head: body.decoded.subarray(0, 8).toString('hex'),
      endsWithBrace: text.trimEnd().endsWith('}'),
      userAgent: original.headers.get('user-agent')?.slice(0, 80) ?? null,
    }
  }
}

export function logUnparsableBody(original: Request, body: DecodedBody): void {
  const info = describeUnparsableBody(original, body)
  if (info) logger.warn(info, 'mcp request body is not valid JSON')
}
