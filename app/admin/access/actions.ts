'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { revokeAllClients, revokeClient, revokeToken } from '@/lib/access'
import { logger } from '@/lib/logger'
import { getPrefix, PREFIX_PATTERN, savePrefix, withPrefix } from '@/lib/prefix'
import { requireAdmin } from '@/lib/session'
import { setDcrAllowed } from '@/lib/settings'

export async function setDcrAction(formData: FormData): Promise<void> {
  await requireAdmin()
  setDcrAllowed(formData.get('allow') === '1')
  revalidatePath('/admin/access')
}

export async function revokeClientAction(formData: FormData): Promise<void> {
  await requireAdmin()
  const clientId = formData.get('clientId')
  if (typeof clientId === 'string' && clientId) revokeClient(clientId)
  revalidatePath('/admin/access')
}

export async function revokeTokenAction(formData: FormData): Promise<void> {
  await requireAdmin()
  const id = formData.get('id')
  if (typeof id === 'string' && id) revokeToken(id)
  revalidatePath('/admin/access')
}

export type PrefixState = { error?: string }

export async function changePrefixAction(_prev: PrefixState, formData: FormData): Promise<PrefixState> {
  await requireAdmin()
  const next = String(formData.get('prefix') ?? '').trim()
  if (!PREFIX_PATTERN.test(next)) return { error: 'Префикс — от 12 до 32 латинских букв и цифр.' }
  if (next === getPrefix()) return { error: 'Это текущий префикс.' }

  savePrefix(next)
  // Tokens are bound to the old /{secret}/api/mcp; Claude has to reconnect with the new URL.
  revokeAllClients()
  logger.info('Path prefix changed, OAuth clients revoked')
  redirect(withPrefix(next, '/admin/access'))
}
