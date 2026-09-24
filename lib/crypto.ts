import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Stored format: v1:<nonce>:<ciphertext>:<tag>, base64url parts. The version prefix
// leaves room to change the algorithm later.
const VERSION = 'v1'

function masterKey(hex: string | undefined = process.env.HUB_MASTER_KEY): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('HUB_MASTER_KEY must be 32 bytes in hex')
  return Buffer.from(hex, 'hex')
}

export function encryptSecret(plaintext: string, keyHex?: string): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey(keyHex), nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [VERSION, nonce.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join(':')
}

export function decryptSecret(stored: string, keyHex?: string): string {
  const [version, nonce, ct, tag] = stored.split(':')
  if (version !== VERSION || !nonce || ct === undefined || !tag) throw new Error('Unsupported secret format')
  const decipher = createDecipheriv('aes-256-gcm', masterKey(keyHex), Buffer.from(nonce, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`) && value.split(':').length === 4
}
