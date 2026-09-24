import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Manual HTML upload in the admin panel: prototypes are up to 5 MB.
  experimental: { serverActions: { bodySizeLimit: '6mb' } },
  serverExternalPackages: ['better-sqlite3', 'pino', '@node-rs/argon2'],
  // Migrations are read from disk at startup; make sure they land in the standalone bundle.
  outputFileTracingIncludes: {
    '/**': ['./lib/db/migrations/**/*'],
  },
}

export default nextConfig
