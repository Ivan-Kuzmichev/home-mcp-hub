'use server'

import { revalidatePath } from 'next/cache'
import { changeLanguage, t, type Lang } from '@/lib/i18n'
import { setCustomInstructions } from '@/lib/settings'
import { requireAdmin } from '@/lib/session'

export async function setLanguageAction(lang: Lang): Promise<{ ok: true } | { error: string }> {
  await requireAdmin()
  const r = changeLanguage(lang)
  if ('ok' in r) revalidatePath('/', 'layout')
  return r
}

export type InitializeState = { ok?: string; error?: string }

const MAX_TEXT = 4000

export async function saveCustomInstructionsAction(enabled: boolean, text: string): Promise<InitializeState> {
  await requireAdmin()
  const clean = text.trim()
  if (enabled && !clean) return { error: t`Empty instructions — write the text or turn the switch off` }
  if (clean.length > MAX_TEXT) return { error: t`Longer than ${MAX_TEXT} characters` }
  setCustomInstructions({ enabled, text: clean })
  revalidatePath('/admin', 'layout')
  return { ok: enabled ? t`Saved — clients get this text in a new chat` : t`Off — the full instructions are sent again` }
}
