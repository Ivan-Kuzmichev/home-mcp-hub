'use server'

import { revalidatePath } from 'next/cache'
import { logAuthEvent } from '@/lib/journal'
import { executeScript, syncSchedules } from '@/lib/scripts/scheduler'
import { deleteSecret, saveSecret } from '@/lib/scripts/secrets'
import { approveScript, deleteScript, getScript, rejectScript, ScriptError, setScriptEnabled } from '@/lib/scripts/store'
import { requireAdmin } from '@/lib/session'

export type ActionState = { error?: string; ok?: string }

const refresh = () => revalidatePath('/admin/scripts', 'layout')

export async function approveAction(id: string, codeHash: string): Promise<ActionState> {
  await requireAdmin()
  try {
    approveScript(id, codeHash)
    logAuthEvent({ event: 'auth.script_review', ok: true, detail: `одобрен «${getScript(id)?.name ?? id}»` })
    syncSchedules()
    refresh()
    return { ok: 'Одобрено и включено' }
  } catch (e) {
    return { error: e instanceof ScriptError ? e.message : String(e) }
  }
}

export async function rejectAction(id: string, codeHash: string, reason: string): Promise<ActionState> {
  await requireAdmin()
  rejectScript(id, codeHash, reason)
  logAuthEvent({ event: 'auth.script_review', ok: false, detail: `отклонён «${getScript(id)?.name ?? id}»`, error: reason || 'без причины' })
  syncSchedules()
  refresh()
  return { ok: 'Отклонено' }
}

export async function setEnabledAction(id: string, enabled: boolean): Promise<ActionState> {
  await requireAdmin()
  const s = getScript(id)
  if (!s) return { error: 'Скрипт не найден' }
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
    return r.ok ? { ok: `Готово за ${(r.durationMs / 1000).toFixed(1)} с`, output: [r.output, ...r.logs].filter(Boolean).join('\n') } : { error: r.error ?? 'Ошибка', output: r.logs.join('\n') }
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
    return { ok: 'Сохранено' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteSecretAction(form: FormData): Promise<void> {
  await requireAdmin()
  deleteSecret(String(form.get('name')))
  refresh()
}
