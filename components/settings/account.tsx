'use client'

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
    if (error) return setMsg({ ok: false, text: error.code === 'PASSWORD_TOO_SHORT' ? 'Новый пароль — от 12 символов' : authErrorMessage(error, 'Не получилось сменить пароль') })
    setMsg({ ok: true, text: 'Пароль сменён, остальные сессии завершены' })
    setCurrent('')
    setNext('')
    setOpen(false)
  }

  return (
    <div className="border-b border-divider">
      <Row title="Пароль" detail={msg?.ok ? msg.text : `изменён ${changedAgo}`}>
        {!open && <Button size="sm" onClick={() => setOpen(true)}>Сменить</Button>}
      </Row>
      {open && (
        <form onSubmit={submit} className="grid gap-3 pb-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pw-cur">Текущий пароль</Label>
            <Input id="pw-cur" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pw-new">Новый пароль, от 12 символов</Label>
            <Input id="pw-new" type="password" autoComplete="new-password" minLength={12} required value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          {msg && !msg.ok && <div className="text-[13px] text-err sm:col-span-2">{msg.text}</div>}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button size="sm" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button size="sm" type="submit" variant="primary" disabled={busy}>
              Сменить пароль
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
    if (error || !data) return setError(authErrorMessage(error, 'Не получилось'))
    setCodes(data.backupCodes)
    setPassword('')
    setError(null)
  }

  return (
    <div className="border-b border-divider">
      <Row title="Второй фактор" detail="TOTP включён · резервные коды на случай потери телефона">
        {!open && <Button size="sm" onClick={() => setOpen(true)}>Новые коды</Button>}
      </Row>
      {open && !codes && (
        <form onSubmit={generate} className="flex flex-wrap items-end gap-2 pb-4">
          <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
            <Label htmlFor="bc-pw">Пароль — старые коды перестанут работать</Label>
            <Input id="bc-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <Button size="sm" onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button size="sm" type="submit" variant="primary">
            Сгенерировать
          </Button>
          {error && <span className="w-full text-[13px] text-err">{error}</span>}
        </form>
      )}
      {codes && (
        <div className="flex flex-col gap-2 pb-4">
          <span className="text-xs text-warn">Сохрани их сейчас — больше они не покажутся.</span>
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
      <Row title="Сессии админки" detail={`${sessions.length} ${sessions.length === 1 ? 'активная' : 'активных'} · ${sessions.map((s) => s.label + (s.current ? ' (эта)' : '')).join(', ')}`}>
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
          Завершить остальные
        </Button>
      </Row>
    </div>
  )
}

export { Row as SettingsRow }
