import { z } from 'zod'

const envSchema = z.object({
  BASE_URL: z
    .string()
    .url()
    .transform((v) => v.replace(/\/+$/, '')),
  DATABASE_PATH: z.string().min(1).default('/data/hub.db'),
  HUB_MASTER_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'HUB_MASTER_KEY must be 32 bytes in hex (openssl rand -hex 32)'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters').optional(),
  TRUST_PROXY: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | undefined

/** Parsed environment. Lazy so that `next build` works without runtime secrets. */
export function env(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      throw new Error(`Invalid environment: ${issues}`)
    }
    cached = parsed.data
  }
  return cached
}
