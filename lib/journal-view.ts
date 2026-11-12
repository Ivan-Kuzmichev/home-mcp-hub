import { localeTag, t, tr } from './i18n'
import { CONNECTORS } from './connectors/registry'
import { AUTH_EVENT_LABELS, type AuthEvent, type JournalFilter, type JournalRow } from './journal'

const CONNECTOR_TAGS: Record<string, string> = {
  ...Object.fromEntries(CONNECTORS.map((c) => [c.id, c.name])),
  hub: 'hub',
  auth: 'sign-in',
}

/** Built per request: labels in the hub language. */
export const journalConnectorOptions = () => Object.entries(CONNECTOR_TAGS).map(([value, label]) => ({ value, label: tr(label) }))

const PERIOD_LIST = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
]

export const periods = () => PERIOD_LIST.map((p) => ({ ...p, label: tr(p.label) }))

export type JournalSearch = { connector?: string; status?: string; period?: string; q?: string; limit?: string }

export function filterFrom(sp: JournalSearch): JournalFilter {
  return {
    connector: sp.connector && CONNECTOR_TAGS[sp.connector] ? sp.connector : undefined,
    status: sp.status === 'ok' || sp.status === 'error' ? sp.status : undefined,
    periodDays: Number(sp.period) || 7,
    q: sp.q?.trim().slice(0, 100) || undefined,
  }
}

export function toolLabel(row: JournalRow): { text: string; mono: boolean } {
  if (row.connectorId === 'auth') return { text: AUTH_EVENT_LABELS[row.tool as AuthEvent] ? tr(AUTH_EVENT_LABELS[row.tool as AuthEvent]) : row.tool, mono: false }
  return { text: row.tool, mono: true }
}

export function connectorTag(row: JournalRow): string {
  return CONNECTOR_TAGS[row.connectorId] ?? row.connectorId
}

export function resultText(row: JournalRow): string {
  if (!row.ok) return row.error ?? t`error`
  return row.resultSummary ?? ''
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  return t`${(ms / 1000).toLocaleString(localeTag(), { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`
}
