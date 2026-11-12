import { connectorStates, enabledTools } from './active'
import { plural } from './format'
import type { ConnectorRow } from './store'
import { t } from '../i18n'

export type ConnectorSummary = {
  id: string
  name: string
  description: string
  configured: boolean
  enabled: boolean
  tone: 'ok' | 'warn' | 'err' | 'muted'
  /** «6 tools · qBittorrent v5.2.3» / «not set up» */
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
      return { ...base, configured: false, enabled: false, tone: 'muted', line: t`not set up`, lastCheckAt: null }
    }
    const row = s.row
    if (s.status === 'disabled') return { ...base, configured: true, enabled: false, tone: 'muted', line: t`off`, lastCheckAt: row.lastCheckAt }
    if (s.status !== 'active') return { ...base, configured: true, enabled: true, tone: 'err', line: t`settings incomplete`, lastCheckAt: row.lastCheckAt }
    const tools = enabledTools(s).length
    const toolsText = `${tools} ${plural(tools, ['tool', 'tools'])}`
    const tone = row.lastCheckOk === null ? 'muted' : row.lastCheckOk ? 'ok' : 'warn'
    const check = checkLine(row)
    return { ...base, configured: true, enabled: true, tone, line: check ? `${toolsText} · ${check}` : toolsText, lastCheckAt: row.lastCheckAt }
  })
}
