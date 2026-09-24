'use server'

import { revalidatePath } from 'next/cache'
import { getConnector } from '@/lib/connectors/registry'
import { getConnectorRow, mergeWithStoredSecrets, recordCheck, saveConfig, setConnectorEnabled, setDisabledTools } from '@/lib/connectors/store'
import type { TestResult } from '@/lib/connectors/types'
import { requireAdmin } from '@/lib/session'

export type FormValues = Record<string, string | boolean>

export type SaveResult = { ok: true; test: TestResult } | { ok: false; errors: Record<string, string> }

function prepare(id: string, values: FormValues) {
  const c = getConnector(id)
  if (!c) throw new Error('Unknown connector')
  // Empty optional text fields mean «not set».
  const cleaned = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''))
  return { c, parsed: c.parseConfig(mergeWithStoredSecrets(c, cleaned)) }
}

export async function saveConnectorAction(id: string, values: FormValues, disabledTools: string[]): Promise<SaveResult> {
  await requireAdmin()
  const { c, parsed } = prepare(id, values)
  if (!parsed.ok) return { ok: false, errors: parsed.errors }
  saveConfig(c, parsed.config as Record<string, unknown>)
  const known = new Set(c.tools.map((t) => t.name))
  setDisabledTools(id, disabledTools.filter((t) => known.has(t)))
  const test = await c.test(parsed.config)
  recordCheck(id, test)
  revalidatePath('/admin/connectors', 'layout')
  return { ok: true, test }
}

export async function testConnectorAction(id: string, values: FormValues): Promise<SaveResult> {
  await requireAdmin()
  const { c, parsed } = prepare(id, values)
  if (!parsed.ok) return { ok: false, errors: parsed.errors }
  const test = await c.test(parsed.config)
  if (getConnectorRow(id)) recordCheck(id, test)
  return { ok: true, test }
}

export async function setConnectorEnabledAction(id: string, enabled: boolean): Promise<void> {
  await requireAdmin()
  if (!getConnectorRow(id)) return
  setConnectorEnabled(id, enabled)
  revalidatePath('/admin/connectors', 'layout')
}
