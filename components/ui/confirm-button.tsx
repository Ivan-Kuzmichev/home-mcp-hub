'use client'

import { useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button } from '@/components/ui/button'
import { t } from '@/components/i18n-client'

/** Destructive action behind an inline «Точно?» step. Renders its own form. */
export function ConfirmButton({
  action,
  fields,
  label,
  confirmLabel = t`Really revoke`,
}: {
  action: (formData: FormData) => Promise<void>
  fields: Record<string, string>
  label: string
  confirmLabel?: string
}) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <Button variant="destructive" size="sm" onClick={() => setAsking(true)}>
        {label}
      </Button>
    )
  }
  return (
    <form action={action} className="flex items-center gap-1.5">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
        {t`Cancel`}
      </Button>
      <SubmitDanger label={confirmLabel} />
    </form>
  )
}

function SubmitDanger({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" variant="destructive" disabled={pending} className="bg-err text-background hover:bg-err/90">
      {label}
    </Button>
  )
}
