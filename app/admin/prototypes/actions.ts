'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { href } from '@/lib/prefix'
import { clearData } from '@/lib/prototypes/data'
import { getById, MAX_HTML_BYTES, PrototypeError, publish, remove, rollback, update, type Expiry } from '@/lib/prototypes/store'
import { requireAdmin } from '@/lib/session'
import { t } from '@/lib/i18n'

export type ActionState = { error?: string; ok?: string }

const EXPIRIES = ['never', '7d', '30d'] as const

function expiryFrom(v: FormDataEntryValue | null): Expiry | undefined {
  return EXPIRIES.find((e) => e === v)
}

async function htmlFrom(file: FormDataEntryValue | null): Promise<string> {
  if (!(file instanceof File) || file.size === 0) throw new PrototypeError(t`Pick an HTML file`)
  if (file.size > MAX_HTML_BYTES) throw new PrototypeError(t`The file is over 5 MB`)
  if (!/\.html?$/i.test(file.name) && !file.type.includes('html')) throw new PrototypeError(t`An .html file is needed`)
  return file.text()
}

async function run(fn: () => Promise<ActionState>): Promise<ActionState> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof PrototypeError) return { error: e.message }
    throw e
  }
}

export async function uploadPrototypeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin()
  let id = ''
  const result = await run(async () => {
    const html = await htmlFrom(form.get('file'))
    const file = form.get('file') as File
    const title = String(form.get('title') ?? '').trim() || file.name.replace(/\.html?$/i, '')
    const pin = String(form.get('pin') ?? '').trim() || undefined
    id = (await publish({ html, title, pin, expiry: expiryFrom(form.get('expiry')) ?? 'never' })).id
    return {}
  })
  if (result.error) return result
  revalidatePath('/admin/prototypes', 'layout')
  redirect(href(`/admin/prototypes/${id}`))
}

export async function savePrototypeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin()
  return run(async () => {
    const p = getById(String(form.get('id')))
    if (!p) return { error: t`Prototype not found` }
    const newPin = String(form.get('pin') ?? '').trim()
    const pinEnabled = form.get('pinEnabled') === 'on'
    let pin: string | null | undefined
    if (!pinEnabled && p.pinHash) pin = null
    else if (pinEnabled && newPin) pin = newPin
    else if (pinEnabled && !p.pinHash) return { error: t`Set a PIN of 4–8 digits` }
    const expiry = form.get('expiry') === 'keep' ? undefined : expiryFrom(form.get('expiry'))
    const title = String(form.get('title') ?? '').trim()
    await update(p, { title: title && title !== p.title ? title : undefined, pin, expiry })
    revalidatePath('/admin/prototypes', 'layout')
    return { ok: t`Saved` }
  })
}

export async function uploadVersionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  await requireAdmin()
  return run(async () => {
    const p = getById(String(form.get('id')))
    if (!p) return { error: t`Prototype not found` }
    const next = await update(p, { html: await htmlFrom(form.get('file')) })
    revalidatePath('/admin/prototypes', 'layout')
    return { ok: t`Uploaded v${next.version}` }
  })
}

export async function rollbackAction(form: FormData): Promise<void> {
  await requireAdmin()
  const p = getById(String(form.get('id')))
  const version = Number(form.get('version'))
  if (p && Number.isInteger(version)) await rollback(p, version)
  revalidatePath('/admin/prototypes', 'layout')
}

export async function deletePrototypeAction(form: FormData): Promise<void> {
  await requireAdmin()
  const p = getById(String(form.get('id')))
  if (p) remove(p)
  revalidatePath('/admin/prototypes', 'layout')
  redirect(href('/admin/prototypes'))
}

export async function clearDataAction(form: FormData): Promise<void> {
  await requireAdmin()
  const p = getById(String(form.get('id')))
  if (p) clearData(p)
  revalidatePath('/admin/prototypes', 'layout')
}
