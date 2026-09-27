import { connectorStates } from '../connectors/active'
import { fieldRegistry, type RegisteredConnector } from '../connectors/types'
import { getSetting, setSetting } from '../settings'

/**
 * Connector settings shared with scripts (toggles on the Scripts screen). Values are read
 * live from the connector, so a changed key or address reaches scripts without copying.
 * Secret fields become real secrets bound to the connector's API host; the rest (address,
 * defaults) are plain values that may go anywhere, including into the URL itself.
 */
export type ConnectorValue = { name: string; label: string; secret: boolean; value: string; hosts: string[] }

const KEY = 'script_connector_secrets'

export function sharedConnectorIds(): string[] {
  try {
    const list: unknown = JSON.parse(getSetting(KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function setConnectorShared(id: string, shared: boolean): void {
  const next = new Set(sharedConnectorIds())
  if (shared) next.add(id)
  else next.delete(id)
  setSetting(KEY, JSON.stringify([...next]))
}

/** JACKETT_API_KEY from jackett.apiKey */
export function valueName(connectorId: string, field: string): string {
  return `${connectorId}_${field.replace(/([a-z0-9])([A-Z])/g, '$1_$2')}`.toUpperCase()
}

/** Fields worth sharing: everything but long texts (Paperless labeling rules and the like). */
function sharedFields(c: RegisteredConnector) {
  return Object.entries(c.shape)
    .map(([key, schema]) => ({ key, meta: fieldRegistry.get(schema) }))
    .filter((f) => f.meta && f.meta.widget !== 'textarea')
    .map((f) => ({ key: f.key, label: f.meta!.label, secret: !!f.meta!.secret }))
}

function apiHost(config: Record<string, unknown>): string | null {
  try {
    return typeof config.baseUrl === 'string' ? new URL(config.baseUrl).hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/** For the Scripts screen: which connectors can be shared and under which names. No values. */
export function describeConnectorSharing() {
  const shared = new Set(sharedConnectorIds())
  return connectorStates()
    .filter((s) => !s.connector.builtin && s.status !== 'unconfigured')
    .map((s) => {
      const config = s.status === 'active' ? (s.config as Record<string, unknown>) : {}
      return {
        id: s.connector.id,
        name: s.connector.name,
        active: s.status === 'active',
        shared: shared.has(s.connector.id),
        host: apiHost(config),
        entries: sharedFields(s.connector).map((f) => ({ name: valueName(s.connector.id, f.key), label: f.label, secret: f.secret })),
      }
    })
}

/** Values for a run: only shared, switched-on connectors, only fields that are set. */
export function connectorValues(): ConnectorValue[] {
  const shared = new Set(sharedConnectorIds())
  return connectorStates().flatMap((s) => {
    if (s.status !== 'active' || !shared.has(s.connector.id)) return []
    // Parsed config: secrets decrypted, defaults filled in, as the connector itself uses them.
    const config = s.config as Record<string, unknown>
    const host = apiHost(config)
    return sharedFields(s.connector).flatMap((f) => {
      const v = config[f.key]
      if (v === undefined || v === null || v === '') return []
      if (f.secret && !host) return []
      return [{ name: valueName(s.connector.id, f.key), label: f.label, secret: f.secret, value: String(v), hosts: f.secret ? [host!] : [] }]
    })
  })
}
