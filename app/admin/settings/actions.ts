'use server'

import { revalidatePath } from 'next/cache'
import { changeLanguage, type Lang } from '@/lib/i18n'
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
  if (enabled && !clean) return { error: 'Пустая инструкция — впиши текст или выключи переключатель' }
  if (clean.length > MAX_TEXT) return { error: `Длиннее ${MAX_TEXT} символов` }
  setCustomInstructions({ enabled, text: clean })
  revalidatePath('/admin', 'layout')
  return { ok: enabled ? 'Сохранено — клиенты получат этот текст в новом чате' : 'Выключено — снова отдаются полные инструкции' }
}
