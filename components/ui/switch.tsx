'use client'

import { cn } from '@/lib/utils'

export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-10 shrink-0 cursor-pointer rounded-full border transition-colors disabled:opacity-50',
        checked ? 'border-primary bg-primary' : 'border-border bg-muted',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 size-[18px] rounded-full transition-all',
          checked ? 'left-[18px] bg-primary-foreground' : 'left-0.5 bg-subtle',
        )}
      />
    </button>
  )
}
