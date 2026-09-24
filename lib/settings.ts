import { eq } from 'drizzle-orm'
import { getDb } from './db'
import { setting } from './db/schema'

export function getSetting(key: string): string | null {
  return getDb().select().from(setting).where(eq(setting.key, key)).get()?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb().insert(setting).values({ key, value }).onConflictDoUpdate({ target: setting.key, set: { value } }).run()
}

/** «Разрешить регистрацию новых клиентов»: off by default, on only while connecting Claude. */
export function isDcrAllowed(): boolean {
  return getSetting('allow_dcr') === '1'
}

export function setDcrAllowed(allowed: boolean): void {
  setSetting('allow_dcr', allowed ? '1' : '0')
}
