'use client'

import { useRef } from 'react'
import { cn } from '@/lib/utils'

/** Six single-digit cells with auto-advance, backspace and paste support. */
export function CodeCells({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled,
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  length?: number
  disabled?: boolean
  autoFocus?: boolean
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([])

  function setAt(index: number, digits: string) {
    const chars = value.padEnd(length, ' ').split('')
    let i = index
    for (const d of digits) {
      if (i >= length) break
      chars[i++] = d
    }
    const next = chars.join('').replace(/\s+$/, '')
    onChange(next)
    refs.current[Math.min(i, length - 1)]?.focus()
    if (next.length === length && !next.includes(' ')) onComplete?.(next)
  }

  return (
    <div className="flex justify-between gap-2">
      {Array.from({ length }, (_, i) => {
        const ch = value[i]?.trim() ?? ''
        return (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el
            }}
            className={cn(
              'h-14 w-12 min-w-0 rounded-[10px] border border-input bg-background p-0 text-center font-mono text-2xl text-foreground focus-visible:border-primary focus-visible:outline-none',
              ch && 'border-primary',
            )}
            type="text"
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            maxLength={length}
            aria-label={`Цифра ${i + 1}`}
            value={ch}
            disabled={disabled}
            autoFocus={autoFocus && i === 0}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, '')
              if (digits) setAt(i, digits.slice(ch ? 1 : 0) || digits)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Backspace') {
                e.preventDefault()
                const chars = value.padEnd(length, ' ').split('')
                const target = ch ? i : Math.max(0, i - 1)
                chars[target] = ' '
                onChange(chars.join('').replace(/\s+$/, ''))
                refs.current[target]?.focus()
              } else if (e.key === 'ArrowLeft') {
                refs.current[i - 1]?.focus()
              } else if (e.key === 'ArrowRight') {
                refs.current[i + 1]?.focus()
              }
            }}
            onPaste={(e) => {
              e.preventDefault()
              const digits = e.clipboardData.getData('text').replace(/\D/g, '')
              if (digits) setAt(i, digits)
            }}
          />
        )
      })}
    </div>
  )
}
