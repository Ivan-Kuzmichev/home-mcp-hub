import { connectorStates } from './active'
import { plural } from './format'
import type { ConnectorRow } from './store'

export type ConnectorSummary = {
  id: string
  name: string
  description: string
  configured: boolean
  enabled: boolean
  tone: 'ok' | 'warn' | 'err' | 'muted'
  /** «6 инструментов · qBittorrent v5.2.3» / «не настроен» */
  line: string
  lastCheckAt: Date | null
}

function checkLine(row: ConnectorRow): string | null {
  return row.lastCheckNote?.split(' · ')[0] ?? null
}

export function connectorSummaries(): ConnectorSummary[] {
  return connectorStates().map((s) => {
    const { connector: c } = s
    const base = { id: c.id, name: c.name, description: c.description }
    if (s.status === 'unconfigured') {
      return { ...base, configured: false, enabled: false, tone: 'muted', line: 'не настроен', lastCheckAt: null }
    }
    const row = s.row
    const tools = c.tools.filter((t) => !row.disabledTools.includes(t.name)).length
    const toolsText = `${tools} ${plural(tools, ['инструмент', 'инструмента', 'инструментов'])}`
    if (s.status === 'disabled') return { ...base, configured: true, enabled: false, tone: 'muted', line: 'выключен', lastCheckAt: row.lastCheckAt }
    if (s.status === 'invalid') return { ...base, configured: true, enabled: true, tone: 'err', line: 'настройки неполные', lastCheckAt: row.lastCheckAt }
    const tone = row.lastCheckOk === null ? 'muted' : row.lastCheckOk ? 'ok' : 'warn'
    const check = checkLine(row)
    return { ...base, configured: true, enabled: true, tone, line: check ? `${toolsText} · ${check}` : toolsText, lastCheckAt: row.lastCheckAt }
  })
}
