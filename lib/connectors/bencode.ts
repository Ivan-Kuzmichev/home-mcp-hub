import { createHash } from 'node:crypto'

// Just enough bencode to find the byte range of the top-level `info` dictionary.

const D = 0x64 // d
const L = 0x6c // l
const I = 0x69 // i
const E = 0x65 // e
const COLON = 0x3a

function skip(buf: Uint8Array, pos: number): number {
  const c = buf[pos]
  if (c === I) {
    const end = buf.indexOf(E, pos)
    if (end < 0) throw new Error('bad int')
    return end + 1
  }
  if (c === L || c === D) {
    let p = pos + 1
    while (buf[p] !== E) {
      if (p >= buf.length) throw new Error('unterminated')
      p = skip(buf, p)
    }
    return p + 1
  }
  if (c !== undefined && c >= 0x30 && c <= 0x39) {
    const colon = buf.indexOf(COLON, pos)
    if (colon < 0) throw new Error('bad string')
    const len = Number(new TextDecoder().decode(buf.subarray(pos, colon)))
    return colon + 1 + len
  }
  throw new Error('bad token')
}

function readString(buf: Uint8Array, pos: number): { value: string; next: number } {
  const colon = buf.indexOf(COLON, pos)
  const len = Number(new TextDecoder().decode(buf.subarray(pos, colon)))
  return { value: new TextDecoder().decode(buf.subarray(colon + 1, colon + 1 + len)), next: colon + 1 + len }
}

/** BitTorrent v1 info hash (hex, lowercase) of a .torrent file, or null if it is not one. */
export function torrentInfoHash(buf: Uint8Array): string | null {
  try {
    if (buf[0] !== D) return null
    let p = 1
    while (buf[p] !== E && p < buf.length) {
      const key = readString(buf, p)
      const end = skip(buf, key.next)
      if (key.value === 'info') return createHash('sha1').update(buf.subarray(key.next, end)).digest('hex')
      p = end
    }
    return null
  } catch {
    return null
  }
}

/** btih from a magnet link (hex or base32), lowercase hex. */
export function magnetInfoHash(magnet: string): string | null {
  const m = /xt=urn:btih:([0-9a-zA-Z]+)/.exec(magnet)
  const raw = m?.[1]
  if (!raw) return null
  if (/^[0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase()
  if (/^[A-Z2-7]{32}$/i.test(raw)) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    let bits = ''
    for (const ch of raw.toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0')
    return (bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2).toString(16).padStart(2, '0')).join('')
  }
  return null
}
