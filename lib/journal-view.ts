import { CONNECTORS } from './connectors/registry'
import { AUTH_EVENT_LABELS, type AuthEvent, type JournalFilter, type JournalRow } from './journal'

const CONNECTOR_TAGS: Record<string, string> = {
  ...Object.fromEntries(CONNECTORS.map((c) => [c.id, c.name])),
  hub: 'hub',
  auth: 'вход',
}

export const JOURNAL_CONNECTOR_OPTIONS = Object.entries(CONNECTOR_TAGS).map(([value, label]) => ({ value, label }))

export const PERIODS = [
  { value: '1', label: 'Последние 24 часа' },
  { value: '7', label: 'Последние 7 дней' },
  { value: '30', label: 'Последние 30 дней' },
]

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
  if (row.connectorId === 'auth') return { text: AUTH_EVENT_LABELS[row.tool as AuthEvent] ?? row.tool, mono: false }
  return { text: row.tool, mono: true }
}

export function connectorTag(row: JournalRow): string {
  return CONNECTOR_TAGS[row.connectorId] ?? row.connectorId
}

export function resultText(row: JournalRow): string {
  if (!row.ok) return row.error ?? 'ошибка'
  return row.resultSummary ?? ''
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  return `${(ms / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} с`
}
