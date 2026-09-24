// Config used only by `pnpm auth:schema` to generate lib/db/auth-schema.ts.
// Keep the plugin list in sync with lib/auth.ts (only plugins that add tables/fields matter).
import { betterAuth } from 'better-auth'
import { jwt, twoFactor } from 'better-auth/plugins'
import { mcp } from '@better-auth/mcp'

export const auth = betterAuth({
  emailAndPassword: { enabled: true },
  plugins: [
    twoFactor(),
    jwt(),
    mcp({ loginPage: '/login', consentPage: '/consent', resource: 'https://hub.example.com/x/api/mcp' }),
  ],
})
