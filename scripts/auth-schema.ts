// Config used only by `pnpm auth:schema` to generate lib/db/auth-schema.ts.
// Keep the plugin list in sync with lib/auth.ts (only plugins that add tables/fields matter).
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { twoFactor } from 'better-auth/plugins'

export const auth = betterAuth({
  database: drizzleAdapter({}, { provider: 'sqlite' }),
  emailAndPassword: { enabled: true },
  plugins: [twoFactor()],
})
