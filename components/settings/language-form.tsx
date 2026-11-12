'use client'

import { useState, useTransition } from 'react'
import { setLanguageAction } from '@/app/admin/settings/actions'
import { useT } from '@/components/i18n-provider'
import type { Lang } from '@/lib/i18n/core'
import { cn } from '@/lib/utils'

const CHOICES: { value: Lang; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
]

export function LanguageForm({ current, fixedByEnv }: { current: Lang; fixedByEnv: boolean }) {
  const { t, tr } = useT()
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={tr('Language')} className="grid auto-cols-fr grid-flow-col gap-1 rounded-md border border-border bg-background p-1 sm:max-w-xs">
        {CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={c.value === current}
            disabled={pending || fixedByEnv}
            onClick={() =>
              start(async () => {
                const r = await setLanguageAction(c.value)
                setError('error' in r ? r.error : null)
              })
            }
            className={cn(
              'cursor-pointer rounded-sm px-2 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground disabled:cursor-default',
              c.value === current && 'bg-secondary text-foreground',
            )}
          >
            <span lang={c.value}>{c.label}</span>
          </button>
        ))}
      </div>
      {fixedByEnv && <span className="text-xs text-warn">{t`The language is set by the HUB_LANG variable on the server; remove it to switch here.`}</span>}
      {error && <span className="text-xs text-err">{error}</span>}
    </div>
  )
}
