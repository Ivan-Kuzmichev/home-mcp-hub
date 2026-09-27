import { connectorStates, type ConnectorState } from './active'
import { readConfig, type ConnectorRow } from './store'
import type { RegisteredConnector } from './types'

/** Tool names the model sees right now: hub_status plus enabled tools of active connectors. */
export function visibleTools(states: ConnectorState[] = connectorStates()): string[] {
  return ['hub_status', ...states.flatMap((s) => (s.status === 'active' ? s.connector.tools.filter((t) => !s.row.disabledTools.includes(t.name)).map((t) => t.name) : []))]
}

/**
 * A connector's part of the server instructions: the built-in text (aware of switched-off
 * tools) plus the admin's own text, or the admin's text alone in «replace» mode.
 */
export function connectorInstructions(
  connector: RegisteredConnector,
  row: Pick<ConnectorRow, 'instructionsMode' | 'instructionsText'>,
  config: unknown,
  tools: string[],
): { standard: string | null; own: string | null; text: string | null } {
  const standard = connector.instructions?.(config, { tools }) ?? null
  const own = row.instructionsText?.trim() || null
  const text = row.instructionsMode === 'replace' ? own : [standard, own].filter(Boolean).join('\n') || null
  return { standard, own, text }
}

/** What the connector form shows: the built-in text for the saved state and the admin's override. */
export function describeInstructions(c: RegisteredConnector, row: ConnectorRow | undefined) {
  const states = connectorStates()
  const state = states.find((s) => s.connector.id === c.id)
  const own = c.tools.filter((t) => !row?.disabledTools.includes(t.name)).map((t) => t.name)
  // The form shows the text as if the connector were on, even while it is off.
  const tools = [...new Set([...visibleTools(states), ...own])]
  const parsed = state?.status === 'active' ? null : c.parseConfig(readConfig(c, row) ?? {})
  const config = state?.status === 'active' ? state.config : parsed?.ok ? parsed.config : {}
  const { standard } = connectorInstructions(c, { instructionsMode: 'append', instructionsText: null }, config, tools)
  return { standard, mode: row?.instructionsMode ?? 'append', text: row?.instructionsText ?? '' } as const
}
