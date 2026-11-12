'use server'

import { revalidatePath } from 'next/cache'
import { getConnector } from '@/lib/connectors/registry'
import { logAuthEvent } from '@/lib/journal'
import { setConnectorShared } from '@/lib/scripts/connector-secrets'
import { executeScript, syncSchedules } from '@/lib/scripts/scheduler'
import { deleteSecret, saveSecret } from '@/lib/scripts/secrets'
import { approveScript, createScript, createTool, deleteScript, getScript, rejectScript, ScriptError, setScriptEnabled } from '@/lib/scripts/store'
import type { ToolParam } from '@/lib/scripts/tool-spec'
import { requireAdmin } from '@/lib/session'
import { t } from '@/lib/i18n'

export type ActionState = { error?: string; ok?: string }

const refresh = () => revalidatePath('/admin/scripts', 'layout')

export async function approveAction(id: string, codeHash: string): Promise<ActionState> {
  await requireAdmin()
  try {
    approveScript(id, codeHash)
    logAuthEvent({ event: 'auth.script_review', ok: true, detail: t`approved “${getScript(id)?.name ?? id}”` })
    syncSchedules()
    refresh()
    return { ok: t`Approved and turned on` }
  } catch (e) {
    return { error: e instanceof ScriptError ? e.message : String(e) }
  }
}

export async function rejectAction(id: string, codeHash: string, reason: string): Promise<ActionState> {
  await requireAdmin()
  const name = getScript(id)?.name ?? id
  try {
    const outcome = rejectScript(id, codeHash)
    logAuthEvent({
      // The admin's decision went through: not an error, whatever was decided.
      event: 'auth.script_review',
      ok: true,
      detail: `${outcome === 'deleted' ? t`rejected and deleted “${name}”` : t`rejected a change to “${name}”, the approved version is back`}${reason ? t` · reason: ${reason}` : ''}`,
    })
    syncSchedules()
    refresh()
    return { ok: outcome === 'deleted' ? t`Rejected, the script is deleted` : t`Change rejected, the previous version runs` }
  } catch (e) {
    return { error: e instanceof ScriptError ? e.message : String(e) }
  }
}

export async function setEnabledAction(id: string, enabled: boolean): Promise<ActionState> {
  await requireAdmin()
  const s = getScript(id)
  if (!s) return { error: t`Script not found` }
  try {
    setScriptEnabled(s, enabled)
    syncSchedules()
    refresh()
    return {}
  } catch (e) {
    return { error: e instanceof ScriptError ? e.message : String(e) }
  }
}

export async function runNowAction(id: string): Promise<ActionState & { output?: string }> {
  await requireAdmin()
  try {
    const r = await executeScript(id, 'manual')
    refresh()
    return r.ok ? { ok: t`Done in ${(r.durationMs / 1000).toFixed(1)} s`, output: [r.output, ...r.logs].filter(Boolean).join('\n') } : { error: r.error ?? t`Error`, output: r.logs.join('\n') }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteScriptAction(form: FormData): Promise<void> {
  await requireAdmin()
  deleteScript(String(form.get('id')))
  syncSchedules()
  refresh()
}

export async function saveSecretAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin()
  try {
    saveSecret({
      name: String(form.get('name') ?? '').trim(),
      value: String(form.get('value') ?? '') || undefined,
      hosts: String(form.get('hosts') ?? '').split(/[\s,]+/),
      description: String(form.get('description') ?? ''),
    })
    refresh()
    return { ok: t`Saved` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteSecretAction(form: FormData): Promise<void> {
  await requireAdmin()
  deleteSecret(String(form.get('name')))
  refresh()
}

export async function setConnectorSharedAction(id: string, shared: boolean): Promise<ActionState> {
  await requireAdmin()
  if (!getConnector(id) || getConnector(id)!.builtin) return { error: t`No such connector` }
  setConnectorShared(id, shared)
  logAuthEvent({ event: 'auth.script_review', ok: true, detail: t`${shared ? t`opened to scripts` : t`closed to scripts`} settings ${getConnector(id)!.name}` })
  refresh()
  return { ok: shared ? t`Open to scripts` : t`Closed` }
}

/** Admin-written tool: approved at once — the admin is the reviewer. */
export async function createToolAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin()
  let params: unknown
  try {
    const raw = String(form.get('params') ?? '').trim()
    params = raw ? JSON.parse(raw) : []
  } catch {
    return { error: t`Parameters are a JSON array, see the example in the field` }
  }
  if (!Array.isArray(params)) return { error: t`Parameters are a JSON array, see the example in the field` }
  try {
    const s = await createTool({
      name: String(form.get('name') ?? ''),
      description: String(form.get('description') ?? ''),
      params: params as ToolParam[],
      readOnly: form.get('readOnly') === 'on',
      code: String(form.get('code') ?? ''),
    })
    approveScript(s.id, s.codeHash)
    logAuthEvent({ event: 'auth.script_review', ok: true, detail: t`added tool ${s.name}` })
    refresh()
    return { ok: t`Added ${s.name} — it reaches the assistant in a new chat` }
  } catch (e) {
    return { error: e instanceof ScriptError ? e.message : String(e) }
  }
}

/** Admin-written cron script: approved (and so switched on) at once. */
export async function createCronAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin()
  try {
    const s = await createScript({
      name: String(form.get('name') ?? ''),
      description: String(form.get('description') ?? ''),
      schedule: String(form.get('schedule') ?? ''),
      code: String(form.get('code') ?? ''),
    })
    approveScript(s.id, s.codeHash)
    logAuthEvent({ event: 'auth.script_review', ok: true, detail: t`added script “${s.name}”` })
    syncSchedules()
    refresh()
    return { ok: t`Added “${s.name}” and turned it on` }
  } catch (e) {
    return { error: e instanceof ScriptError ? e.message : String(e) }
  }
}
