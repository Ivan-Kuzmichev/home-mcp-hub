import { connectorStates } from '../connectors/active'
import { connectorInstructions, visibleTools } from '../connectors/instructions'
import { getMcpHandler } from './server'

export type InspectedTool = {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
  annotations?: Record<string, unknown>
}

export type McpSnapshot = {
  serverInfo: { name: string; title?: string; version: string }
  protocolVersion: string
  instructions: string
  tools: InspectedTool[]
  /** Which connector contributed which part of the instructions. */
  parts: { connector: string; mode: 'append' | 'replace'; standard: string | null; own: string | null; text: string | null }[]
}

const PROTOCOL = '2025-06-18'

/** Calls the MCP handler in-process, exactly as a client would, without auth (the route adds it). */
export async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await getMcpHandler()(
    new Request('http://hub/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  const text = await res.text()
  const json = text.includes('data: ') ? text.split('data: ')[1]!.split('\n')[0]! : text
  const body = JSON.parse(json) as { result?: T; error?: { message: string } }
  if (!body.result) throw new Error(body.error?.message ?? `MCP ${method} failed`)
  return body.result
}

export async function inspectMcp(): Promise<McpSnapshot> {
  const init = await rpc<{ serverInfo: McpSnapshot['serverInfo']; protocolVersion: string; instructions?: string }>('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'hub-diagnostics', version: '1' },
  })
  const { tools } = await rpc<{ tools: InspectedTool[] }>('tools/list')
  const states = connectorStates()
  const names = visibleTools(states)
  const parts = states.flatMap((s) =>
    s.status === 'active' ? [{ connector: s.connector.name, mode: s.row.instructionsMode, ...connectorInstructions(s.connector, s.row, s.config, names) }] : [],
  )
  return { serverInfo: init.serverInfo, protocolVersion: init.protocolVersion, instructions: init.instructions ?? '', tools, parts }
}

/** Rough token count: Russian text runs at about 3 characters per token, JSON a bit more. */
export function approxTokens(chars: number): number {
  return Math.round(chars / 3)
}
