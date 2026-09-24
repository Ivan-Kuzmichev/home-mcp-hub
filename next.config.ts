import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3', 'pino'],
  // Migrations are read from disk at startup; make sure they land in the standalone bundle.
  outputFileTracingIncludes: {
    '/**': ['./lib/db/migrations/**/*'],
  },
}

export default nextConfig
