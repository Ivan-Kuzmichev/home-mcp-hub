'use client'

import { plural, t } from '@/components/i18n-client'
import { Delete } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const MIN = 4
const MAX = 8

type Status = { kind: 'idle' } | { kind: 'wrong'; remaining: number } | { kind: 'locked'; retryAfter: number } | { kind: 'error' }

function attemptsWord(n: number): string {
  return plural(n, ['attempt', 'attempts'])
}

/**
 * Pin entry: exactly `length` cells and auto-submit when they are filled. For pins set
 * before the length was stored, cells grow from 4 to 8 as digits come in.
 * Keyboard on desktop, on-screen keypad on the phone.
 */
export function PinForm({ slug, title, length }: { slug: string; title: string; length?: number }) {
  const max = length ?? MAX
  const min = length ?? MIN
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const locked = status.kind === 'locked'

  const press = useCallback(
    (key: string) => {
      if (busy || locked) return
      if (key === 'back') return setPin((p) => p.slice(0, -1))
      if (/^\d$/.test(key)) {
        setStatus((s) => (s.kind === 'wrong' ? { kind: 'idle' } : s))
        setPin((p) => (p.length < max ? p + key : p))
      }
    },
    [busy, locked, max],
  )

  const submit = useCallback(async () => {
    if (pin.length < min || busy || locked) return
    setBusy(true)
    try {
      const res = await fetch(`/p/${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) })
      const body = (await res.json().catch(() => ({}))) as { remaining?: number; retryAfter?: number }
      if (res.ok) return window.location.assign(`/p/${slug}`)
      setPin('')
      if (res.status === 429) setStatus({ kind: 'locked', retryAfter: body.retryAfter ?? 600 })
      else if (res.status === 401) setStatus({ kind: 'wrong', remaining: body.remaining ?? 0 })
      else setStatus({ kind: 'error' })
    } catch {
      setStatus({ kind: 'error' })
    } finally {
      setBusy(false)
    }
  }, [pin, busy, locked, slug, min])

  // Known length: send as soon as the last digit is in.
  useEffect(() => {
    if (length && pin.length === length) void submit()
  }, [length, pin, submit])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (/^\d$/.test(e.key)) press(e.key)
      else if (e.key === 'Backspace') press('back')
      else if (e.key === 'Enter') void submit()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [press, submit])

  // Count down the lock so the page unlocks itself.
  useEffect(() => {
    if (status.kind !== 'locked') return
    const t = setInterval(() => {
      setStatus((s) => (s.kind !== 'locked' ? s : s.retryAfter <= 1 ? { kind: 'idle' } : { kind: 'locked', retryAfter: s.retryAfter - 1 }))
    }, 1000)
    return () => clearInterval(t)
  }, [status.kind])

  const cells = length ?? Math.min(MAX, Math.max(MIN, pin.length + (pin.length >= MIN && pin.length < MAX ? 1 : 0)))

  return (
    <Card className="flex w-full max-w-[400px] flex-col items-center gap-6 border-0 bg-transparent p-0 sm:border sm:bg-card sm:p-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="text-xs font-semibold tracking-[0.06em] text-subtle uppercase">{t`Prototype`}</span>
        <h1 className="text-2xl">{title}</h1>
        <p className="text-muted-foreground">
          {t`The page is closed with a PIN. Whoever sent the link knows it`}<span className="hidden sm:inline"> {t`— type`} {length ? `${length} ${plural(length, ['digit', 'digits'])}` : t`the digits`} {t`on the keyboard`}</span>.
        </p>
      </div>

      <div className="flex flex-col items-center gap-2.5" aria-live="polite">
        <div className="flex gap-2" role="img" aria-label={t`Digits entered: ${pin.length}`}>
          {Array.from({ length: cells }, (_, i) => (
            <div
              key={i}
              className={cn(
                'flex h-14 w-11 items-center justify-center rounded-[10px] border bg-background font-mono text-2xl sm:w-12',
                i < pin.length ? 'border-primary' : 'border-input',
                status.kind === 'wrong' && 'border-err',
              )}
            >
              {i < pin.length ? '•' : ''}
            </div>
          ))}
        </div>
        <div className="h-5 text-[13px]">
          {status.kind === 'wrong' && (
            <span className="text-err">
              {t`Wrong PIN ·`} {status.remaining} {attemptsWord(status.remaining)}
            </span>
          )}
          {status.kind === 'locked' && (
            <span className="text-warn">
              {t`Too many attempts · wait`} {Math.floor(status.retryAfter / 60)}:{String(status.retryAfter % 60).padStart(2, '0')}
            </span>
          )}
          {status.kind === 'error' && <span className="text-err">{t`Could not check the PIN, try again`}</span>}
        </div>
      </div>

      <div className="grid w-full max-w-[300px] grid-cols-3 gap-2.5 sm:hidden">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Key key={d} onPress={() => press(d)} disabled={busy || locked}>
            {d}
          </Key>
        ))}
        <span />
        <Key onPress={() => press('0')} disabled={busy || locked}>
          0
        </Key>
        <Key onPress={() => press('back')} disabled={busy || locked} label={t`Erase`}>
          <Delete size={22} />
        </Key>
      </div>

      <Button variant="primary" className="w-full max-w-[300px]" disabled={pin.length < min || busy || locked} onClick={() => void submit()}>
        {busy ? t`Checking…` : t`Open`}
      </Button>

      <div className="flex flex-col items-center gap-0.5 text-center text-xs text-subtle">
        <span>{t`Access is kept in this browser for 24 hours`}</span>
        <span>{t`5 attempts per 10 minutes`}</span>
      </div>
    </Card>
  )
}

function Key({ children, onPress, disabled, label }: { children: React.ReactNode; onPress: () => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onPress}
      className="flex h-14 cursor-pointer items-center justify-center rounded-xl bg-secondary font-heading text-2xl font-semibold text-foreground active:bg-muted disabled:opacity-50"
    >
      {children}
    </button>
  )
}
