import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Prototype } from './store'

export const ACCESS_TTL_MS = 24 * 60 * 60 * 1000
export const ATTEMPT_WINDOW_MS = 10 * 60 * 1000
export const MAX_ATTEMPTS_PER_IP = 5
// A 4-digit pin must not fall to many IPs either.
export const MAX_ATTEMPTS_PER_SLUG = 30

export function accessCookieName(slug: string): string {
  return `pa_${slug}`
}

function key(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set')
  return createHash('sha256').update(`${secret}:prototype-access`).digest()
}

function mac(payload: string): string {
  return createHmac('sha256', key()).update(payload).digest('base64url')
}

/** `<pinVersion>.<expiresMs>.<hmac(slug.pinVersion.expires)>` */
export function signAccess(p: Pick<Prototype, 'slug' | 'pinVersion'>, now = Date.now()): string {
  const exp = now + ACCESS_TTL_MS
  return `${p.pinVersion}.${exp}.${mac(`${p.slug}.${p.pinVersion}.${exp}`)}`
}

export function verifyAccess(value: string | undefined, p: Pick<Prototype, 'slug' | 'pinVersion'>, now = Date.now()): boolean {
  if (!value) return false
  const [ver, exp, sig] = value.split('.')
  if (!ver || !exp || !sig) return false
  if (Number(ver) !== p.pinVersion || Number(exp) < now) return false
  const expected = Buffer.from(mac(`${p.slug}.${ver}.${exp}`))
  const given = Buffer.from(sig)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

// ---------------------------------------------------------------------------
// Attempt limiter, in memory: one process, and a restart resetting it is fine.

const attempts = new Map<string, number[]>()

function recent(k: string, now: number): number[] {
  const list = (attempts.get(k) ?? []).filter((t) => now - t < ATTEMPT_WINDOW_MS)
  attempts.set(k, list)
  return list
}

export type AttemptState = { allowed: boolean; remaining: number; retryAfterSec: number }

export function attemptState(slug: string, ip: string, now = Date.now()): AttemptState {
  const byIp = recent(`${slug}|${ip}`, now)
  const bySlug = recent(slug, now)
  const remaining = Math.max(0, Math.min(MAX_ATTEMPTS_PER_IP - byIp.length, MAX_ATTEMPTS_PER_SLUG - bySlug.length))
  const oldest = Math.min(byIp[0] ?? now, bySlug.length >= MAX_ATTEMPTS_PER_SLUG ? (bySlug[0] ?? now) : now)
  return { allowed: remaining > 0, remaining, retryAfterSec: remaining > 0 ? 0 : Math.ceil((oldest + ATTEMPT_WINDOW_MS - now) / 1000) }
}

export function recordFailedAttempt(slug: string, ip: string, now = Date.now()): void {
  recent(`${slug}|${ip}`, now).push(now)
  recent(slug, now).push(now)
}

export function clearAttempts(slug: string, ip: string): void {
  attempts.delete(`${slug}|${ip}`)
}

export { clientIp } from '../net'
