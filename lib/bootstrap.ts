import path from 'node:path'
import { count } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getAuth } from './auth'
import { getDb } from './db'
import { user } from './db/schema'
import { env } from './env'
import { logger } from './logger'
import { generatePrefix, readPrefix, savePrefix } from './prefix'

/** Runs once per process from instrumentation.ts, before the server takes requests. */
export async function bootstrap(): Promise<void> {
  const e = env()
  const db = getDb()

  migrate(db, { migrationsFolder: path.join(process.cwd(), 'lib/db/migrations') })

  let prefix = readPrefix()
  if (!prefix) {
    prefix = generatePrefix()
    savePrefix(prefix)
    // The only place the prefix is ever logged: without it the admin panel is unreachable.
    logger.warn(`Secret path prefix generated. Admin panel: ${e.BASE_URL}/${prefix}/login`)
  }

  await ensureAdmin()
  logger.info('hub started')
}

async function ensureAdmin(): Promise<void> {
  const e = env()
  const db = getDb()
  const users = db.select({ n: count() }).from(user).get()
  if ((users?.n ?? 0) > 0) return

  if (!e.ADMIN_EMAIL || !e.ADMIN_PASSWORD) {
    logger.error('No admin user yet: set ADMIN_EMAIL and ADMIN_PASSWORD and restart')
    return
  }

  const ctx = await getAuth().$context
  const created = await ctx.internalAdapter.createUser({
    email: e.ADMIN_EMAIL.toLowerCase(),
    name: e.ADMIN_EMAIL.split('@')[0] ?? 'admin',
    emailVerified: true,
  }, { method: 'email-password' })
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: await ctx.password.hash(e.ADMIN_PASSWORD),
  })
  logger.info('Admin user created from ADMIN_EMAIL; set up 2FA on first login')
}
