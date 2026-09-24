import * as React from 'react'
import { cn } from '@/lib/utils'

export type PillTone = 'ok' | 'warn' | 'err' | 'muted'

const tones: Record<PillTone, string> = {
  ok: 'bg-ok/14 text-ok',
  warn: 'bg-warn/14 text-warn',
  err: 'bg-err/14 text-err',
  muted: 'bg-muted text-muted-foreground',
}

const dots: Record<PillTone, string> = { ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err', muted: 'bg-subtle' }

export function Pill({
  tone = 'muted',
  dot = false,
  className,
  children,
}: {
  tone?: PillTone
  dot?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-[9px] py-[3px] text-xs font-medium',
        tones[tone],
        className,
      )}
    >
      {dot && <StatusDot tone={tone} />}
      {children}
    </span>
  )
}

export function StatusDot({ tone, className }: { tone: PillTone; className?: string }) {
  return <span className={cn('size-2 shrink-0 rounded-full', dots[tone], className)} />
}
