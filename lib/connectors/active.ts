import { logger } from '../logger'
import { CONNECTORS } from './registry'
import { listConnectorRows, readConfig, type ConnectorRow } from './store'
import type { RegisteredConnector } from './types'

export type ConnectorState =
  | { connector: RegisteredConnector; status: 'unconfigured'; row?: undefined }
  | { connector: RegisteredConnector; status: 'disabled' | 'invalid'; row: ConnectorRow }
  | { connector: RegisteredConnector; status: 'active'; row: ConnectorRow; config: unknown }

/** Every registered connector with its stored state; config only for enabled, valid ones. */
export function connectorStates(): ConnectorState[] {
  const rows = new Map(listConnectorRows().map((r) => [r.id, r]))
  return CONNECTORS.map((connector): ConnectorState => {
    const row = rows.get(connector.id)
    if (!row) return { connector, status: 'unconfigured' }
    if (!row.enabled) return { connector, status: 'disabled', row }
    const parsed = connector.parseConfig(readConfig(connector, row))
    if (!parsed.ok) {
      logger.warn({ connector: connector.id, fields: Object.keys(parsed.errors) }, 'stored connector config is invalid')
      return { connector, status: 'invalid', row }
    }
    return { connector, status: 'active', row, config: parsed.config }
  })
}

export function activeConfig(id: string): unknown | null {
  const state = connectorStates().find((s) => s.connector.id === id)
  return state?.status === 'active' ? state.config : null
}
