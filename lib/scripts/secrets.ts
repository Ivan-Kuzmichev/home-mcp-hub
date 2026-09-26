import { asc, eq } from 'drizzle-orm'
import { decryptSecret, encryptSecret } from '../crypto'
import { getDb } from '../db'
import { scriptSecret } from '../db/schema'

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/
const PLACEHOLDER = /\{\{secret:([A-Z][A-Z0-9_]{1,63})\}\}/g

export type SecretInfo = { name: string; hosts: string[]; description: string; updatedAt: Date }

export function listSecrets(): SecretInfo[] {
  return getDb()
    .select({ name: scriptSecret.name, hosts: scriptSecret.hosts, description: scriptSecret.description, updatedAt: scriptSecret.updatedAt })
    .from(scriptSecret)
    .orderBy(asc(scriptSecret.name))
    .all()
}

export function normalizeHosts(raw: string[]): string[] {
  return [...new Set(raw.map((h) => h.trim().toLowerCase()).filter(Boolean))]
}

export function isValidHostPattern(h: string): boolean {
  return /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)
}

export function saveSecret(input: { name: string; value?: string; hosts: string[]; description?: string }): void {
  if (!SECRET_NAME.test(input.name)) throw new Error('Имя — заглавные латинские буквы, цифры и _, например TELEGRAM_TOKEN')
  const hosts = normalizeHosts(input.hosts)
  if (hosts.length === 0 || !hosts.every(isValidHostPattern)) throw new Error('Хосты — например api.telegram.org или *.example.com')
  const existing = getDb().select().from(scriptSecret).where(eq(scriptSecret.name, input.name)).get()
  if (!existing && !input.value) throw new Error('Нужно значение секрета')
  const values = {
    name: input.name,
    valueEnc: input.value ? encryptSecret(input.value) : existing!.valueEnc,
    hosts,
    description: (input.description ?? existing?.description ?? '').slice(0, 300),
    updatedAt: new Date(),
  }
  getDb().insert(scriptSecret).values(values).onConflictDoUpdate({ target: scriptSecret.name, set: values }).run()
}

export function deleteSecret(name: string): void {
  getDb().delete(scriptSecret).where(eq(scriptSecret.name, name)).run()
}

function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase()
  return patterns.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p))
}

/** Loaded once per run: names → decrypted values and allowed hosts. */
export class SecretVault {
  private readonly secrets = new Map<string, { value: string; hosts: string[] }>()

  constructor() {
    for (const row of getDb().select().from(scriptSecret).all()) {
      try {
        this.secrets.set(row.name, { value: decryptSecret(row.valueEnc), hosts: row.hosts })
      } catch {
        // Undecryptable (master key changed): simply unavailable.
      }
    }
  }

  /**
   * Replace {{secret:NAME}} in a piece of an outgoing request. Only for the secret's hosts:
   * a placeholder bound for any other host is refused, so a script cannot send a token away.
   */
  substitute(text: string, host: string): string {
    return text.replace(PLACEHOLDER, (_m, name: string) => {
      const s = this.secrets.get(name)
      if (!s) throw new SecretPolicyError(`Секрета ${name} нет — список: cron_secrets`)
      if (!hostAllowed(host, s.hosts)) throw new SecretPolicyError(`Секрет ${name} нельзя отправлять на ${host} (разрешено: ${s.hosts.join(', ')})`)
      return s.value
    })
  }

  /** Belt and braces: no secret value leaves a run in output, logs or errors. */
  redact(text: string): string {
    let out = text
    for (const [name, s] of this.secrets) if (s.value.length >= 4) out = out.split(s.value).join(`{{secret:${name}}}`)
    return out
  }
}

export class SecretPolicyError extends Error {}
