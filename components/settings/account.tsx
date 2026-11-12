'use client'

import { t, trc } from '@/components/i18n-client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authErrorMessage, useAuthClient } from '@/lib/auth-client'

function Row({ title, detail, children }: { title: string; detail: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-divider py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-subtle">{detail}</span>
      </div>
      {children}
    </div>
  )
}

export function PasswordRow({ changedAgo }: { changedAgo: string }) {
  const auth = useAuthClient()
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    // Other sessions are signed out: a changed password should lock out whoever had the old one.
    const { error } = await auth.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true })
    setBusy(false)
    if (error) return setMsg({ ok: false, text: error.code === 'PASSWORD_TOO_SHORT' ? t`The new password is 12 characters or more` : authErrorMessage(error, t`Could not change the password`) })
    setMsg({ ok: true, text: t`Password changed, other sessions ended` })
    setCurrent('')
    setNext('')
    setOpen(false)
  }

  return (
    <div className="border-b border-divider">
      <Row title={t`Password`} detail={msg?.ok ? msg.text : t`changed ${changedAgo}`}>
        {!open && <Button size="sm" onClick={() => setOpen(true)}>{t`Change`}</Button>}
      </Row>
      {open && (
        <form onSubmit={submit} className="grid gap-3 pb-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pw-cur">{t`Current password`}</Label>
            <Input id="pw-cur" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pw-new">{t`New password, 12 characters or more`}</Label>
            <Input id="pw-new" type="password" autoComplete="new-password" minLength={12} required value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          {msg && !msg.ok && <div className="text-[13px] text-err sm:col-span-2">{msg.text}</div>}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button size="sm" onClick={() => setOpen(false)}>
              {t`Cancel`}
            </Button>
            <Button size="sm" type="submit" variant="primary" disabled={busy}>
              {t`Change password`}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

export function BackupCodesRow() {
  const auth = useAuthClient()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function generate(e: React.FormEvent) {
    e.preventDefault()
    const { data, error } = await auth.twoFactor.generateBackupCodes({ password })
    if (error || !data) return setError(authErrorMessage(error, t`Failed`))
    setCodes(data.backupCodes)
    setPassword('')
    setError(null)
  }

  return (
    <div className="border-b border-divider">
      <Row title={t`Second factor`} detail={t`TOTP is on · backup codes in case you lose the phone`}>
        {!open && <Button size="sm" onClick={() => setOpen(true)}>{t`New codes`}</Button>}
      </Row>
      {open && !codes && (
        <form onSubmit={generate} className="flex flex-wrap items-end gap-2 pb-4">
          <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
            <Label htmlFor="bc-pw">{t`Password — the old codes will stop working`}</Label>
            <Input id="bc-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <Button size="sm" onClick={() => setOpen(false)}>
            {t`Cancel`}
          </Button>
          <Button size="sm" type="submit" variant="primary">
            {t`Generate`}
          </Button>
          {error && <span className="w-full text-[13px] text-err">{error}</span>}
        </form>
      )}
      {codes && (
        <div className="flex flex-col gap-2 pb-4">
          <span className="text-xs text-warn">{t`Save them now — they will not be shown again.`}</span>
          <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-background p-3 font-mono text-xs sm:grid-cols-5">
            {codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function SessionsRow({ sessions }: { sessions: { id: string; label: string; current: boolean }[] }) {
  const auth = useAuthClient()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const others = sessions.filter((s) => !s.current).length
  return (
    <div>
      <Row title={t`Admin sessions`} detail={`${sessions.length} ${sessions.length === 1 ? trc('session', 'active') : trc('many', 'active')} · ${sessions.map((s) => s.label + (s.current ? t` (this one)` : '')).join(', ')}`}>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy || others === 0}
          onClick={async () => {
            setBusy(true)
            await auth.revokeOtherSessions()
            setBusy(false)
            router.refresh()
          }}
        >
          {t`End the others`}
        </Button>
      </Row>
    </div>
  )
}

export { Row as SettingsRow }
