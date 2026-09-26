import cron from 'node-cron'
import { checkAllConnectors } from './connectors/health'
import { purgeExpiredLinks, purgeOldChanges } from './connectors/paperless/logic'
import { purgeJournal } from './journal'
import { logger } from './logger'
import { purgeExpiredResults } from './mcp/result-cache'
import { purgeExpired as purgeExpiredPrototypes } from './prototypes/store'

const HEALTH_TIMEOUT_MS = 30_000

export async function runHealthCheck(): Promise<void> {
  const results = await checkAllConnectors(HEALTH_TIMEOUT_MS)
  const failed = results.filter((r) => !r.ok).map((r) => r.id)
  if (failed.length) logger.warn({ failed }, 'connector health check failed')
}

export function runCleanup(): { prototypes: number; journal: number } {
  purgeExpiredResults()
  const prototypes = purgeExpiredPrototypes()
  const journal = purgeJournal()
  purgeExpiredLinks()
  purgeOldChanges()
  if (prototypes || journal) logger.info({ prototypes, journal }, 'cleanup')
  return { prototypes, journal }
}

function safe(name: string, fn: () => unknown): () => Promise<void> {
  return async () => {
    try {
      await fn()
    } catch (e) {
      logger.error({ job: name, err: e instanceof Error ? e.message : String(e) }, 'job failed')
    }
  }
}

const globalForJobs = globalThis as unknown as { __hubJobs?: boolean }

/**
 * Next.js has no scheduler, so node-cron runs inside the server process, started from
 * instrumentation.ts: connector health every 2 minutes; expired prototypes, the
 * result_id cache and the 30-day journal cleaned up hourly.
 */
export function startJobs(): void {
  if (globalForJobs.__hubJobs) return
  globalForJobs.__hubJobs = true
  cron.schedule('*/2 * * * *', safe('health', runHealthCheck), { name: 'health', noOverlap: true })
  cron.schedule('7 * * * *', safe('cleanup', runCleanup), { name: 'cleanup', noOverlap: true })
  // First pass right away so the dashboard is not empty after a restart.
  void safe('health', runHealthCheck)()
  void safe('cleanup', runCleanup)()
  logger.info('background jobs started')
}
