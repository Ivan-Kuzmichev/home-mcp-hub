import { connectorStates, type ConnectorState } from './active'
import { recordCheck } from './store'
import type { TestResult } from './types'

export type ActiveState = Extract<ConnectorState, { status: 'active' }>

/** Run a connector's test with a hard timeout and store the result as the last check. */
export async function checkConnector(state: ActiveState, timeoutMs: number): Promise<TestResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<TestResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, summary: `не ответил за ${Math.round(timeoutMs / 1000)} с`, details: [] }), timeoutMs)
  })
  const result = await Promise.race([state.connector.test(state.config).catch((e: unknown) => ({ ok: false, summary: String(e), details: [] })), timeout])
  clearTimeout(timer)
  recordCheck(state.connector.id, result)
  return result
}

export async function checkAllConnectors(timeoutMs: number): Promise<{ id: string; ok: boolean }[]> {
  const active = connectorStates().filter((s): s is ActiveState => s.status === 'active')
  return Promise.all(active.map(async (s) => ({ id: s.connector.id, ok: (await checkConnector(s, timeoutMs)).ok })))
}
