import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { magnetInfoHash, torrentInfoHash } from '@/lib/connectors/bencode'
import { decryptSecret, encryptSecret, isEncrypted } from '@/lib/crypto'

const KEY = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

describe('secret encryption', () => {
  it('round-trips with a fresh nonce each time', () => {
    const a = encryptSecret('hunter2', KEY)
    const b = encryptSecret('hunter2', KEY)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/)
    expect(isEncrypted(a)).toBe(true)
    expect(decryptSecret(a, KEY)).toBe('hunter2')
  })

  it('fails with another key or a tampered value', () => {
    const v = encryptSecret('hunter2', KEY)
    expect(() => decryptSecret(v, OTHER)).toThrow()
    const [ver, nonce, ct, tag] = v.split(':')
    // Change the first character: the last one may only carry padding bits.
    const flipped = (ct!.startsWith('A') ? 'B' : 'A') + ct!.slice(1)
    expect(() => decryptSecret([ver, nonce, flipped, tag].join(':'), KEY)).toThrow()
  })

  it('rejects a malformed key', () => {
    expect(() => encryptSecret('x', 'short')).toThrow(/HUB_MASTER_KEY/)
  })
})

describe('info hashes', () => {
  it('computes the v1 info hash of a .torrent', () => {
    // d8:announce3:foo4:infod4:name3:bar6:lengthi5eee → sha1 of the info dict bytes
    const info = 'd4:name3:bar6:lengthi5ee'
    const torrent = new TextEncoder().encode(`d8:announce3:foo4:info${info}e`)
    expect(torrentInfoHash(torrent)).toBe(createHash('sha1').update(info).digest('hex'))
    expect(torrentInfoHash(new TextEncoder().encode('<html>'))).toBeNull()
  })

  it('reads hex and base32 btih from magnets', () => {
    const hex = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a'
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=x`)).toBe(hex)
    // base32 of the same 20 bytes
    const base32 = 'YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK'
    expect(magnetInfoHash(`magnet:?xt=urn:btih:${base32}`)).toBe(hex)
    expect(magnetInfoHash('https://example.com')).toBeNull()
  })
})
