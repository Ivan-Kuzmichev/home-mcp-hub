import { t } from '../i18n'
// Run limits the admin can change in the scripts connector. Defaults are the old fixed values;
// the bounds keep one script from holding the hub (memory and the state limits stay fixed).

export type RunLimits = {
  /** Whole run */
  timeMs: number
  fetches: number
  /** One fetch, never past the run's deadline */
  fetchTimeoutMs: number
  responseBytes: number
}

export const DEFAULT_LIMITS: RunLimits = { timeMs: 30_000, fetches: 20, fetchTimeoutMs: 15_000, responseBytes: 1024 * 1024 }

/** An MCP call is awaited by the model: kept well below the client's own timeout by default. */
export const DEFAULT_TOOL_TIME_MS = 25_000

export const BOUNDS = {
  cronTimeSec: { min: 5, max: 600 },
  toolTimeSec: { min: 5, max: 120 },
  fetchTimeoutSec: { min: 1, max: 120 },
  maxFetches: { min: 1, max: 200 },
  // A response lands in the 64 MB sandbox as a string and once more after JSON.parse.
  maxResponseMb: { min: 1, max: 5 },
} as const

/** The limit fields of the scripts connector config (all optional: an old saved config has none). */
export type LimitSettings = { cronTimeSec?: number; toolTimeSec?: number; fetchTimeoutSec?: number; maxFetches?: number; maxResponseMb?: number }

const clamp = (v: number | undefined, b: { min: number; max: number }, fallback: number) => (v === undefined || !Number.isFinite(v) ? fallback : Math.min(b.max, Math.max(b.min, v)))

export function limitsFor(kind: 'cron' | 'tool', s: LimitSettings | null | undefined): RunLimits {
  const time = kind === 'tool' ? clamp(s?.toolTimeSec, BOUNDS.toolTimeSec, DEFAULT_TOOL_TIME_MS / 1000) : clamp(s?.cronTimeSec, BOUNDS.cronTimeSec, DEFAULT_LIMITS.timeMs / 1000)
  return {
    timeMs: time * 1000,
    fetches: clamp(s?.maxFetches, BOUNDS.maxFetches, DEFAULT_LIMITS.fetches),
    fetchTimeoutMs: clamp(s?.fetchTimeoutSec, BOUNDS.fetchTimeoutSec, DEFAULT_LIMITS.fetchTimeoutMs / 1000) * 1000,
    responseBytes: clamp(s?.maxResponseMb, BOUNDS.maxResponseMb, DEFAULT_LIMITS.responseBytes / 1024 / 1024) * 1024 * 1024,
  }
}

/** One line for the model: what a script it writes may spend. */
export function limitsLine(s: LimitSettings | null | undefined): string {
  const cron = limitsFor('cron', s)
  const tool = limitsFor('tool', s)
  return t`Limits: cron script ${cron.timeMs / 1000} s, own tool ${tool.timeMs / 1000} s, one fetch up to ${cron.fetchTimeoutMs / 1000} s, ${cron.fetches} requests, response up to ${cron.responseBytes / 1024 / 1024} MB, memory 64 MB.`
}
