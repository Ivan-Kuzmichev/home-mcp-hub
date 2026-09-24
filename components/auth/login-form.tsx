'use client'

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { CodeCells } from '@/components/auth/code-cells'
import { useHref } from '@/components/prefix-provider'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authErrorMessage, oauthRedirectUrl, useAuthClient } from '@/lib/auth-client'

type Step = 'password' | 'totp' | 'backup' | 'setup'

const STEP_LABEL: Record<Step, string> = {
  password: 'Шаг 1 · Пароль',
  totp: 'Шаг 2 · Второй фактор',
  backup: 'Шаг 2 · Резервный код',
  setup: 'Шаг 2 · Настройка 2FA',
}

export function LoginForm({ initialStep, oauth }: { initialStep: 'password' | 'setup'; oauth: boolean }) {
  const auth = useAuthClient({ oauth })
  const href = useHref()
  const [step, setStep] = useState<Step>(initialStep)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function go(next: Step) {
    setError(null)
    setCode('')
    setStep(next)
  }

  /** After the second factor: continue the OAuth flow for Claude, or open the admin panel. */
  function finish(data: unknown) {
    // Full navigation so the server sees the fresh session cookie.
    window.location.assign(oauthRedirectUrl(data) ?? href('/admin'))
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { data, error } = await auth.signIn.email({ email, password })
    setBusy(false)
    if (error) return setError(authErrorMessage(error, error.status === 401 ? 'Неверный email или пароль.' : `Не получилось войти (ошибка ${error.status ?? '?'})`))
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) return go('totp')
    // Signed in, but 2FA is not set up yet: it is mandatory for the admin.
    go('setup')
  }

  async function submitTotp(value = code) {
    if (value.length !== 6) return
    setBusy(true)
    setError(null)
    const { data, error } = await auth.twoFactor.verifyTotp({ code: value })
    setBusy(false)
    if (error) {
      setCode('')
      return setError(authErrorMessage(error, 'Неверный код.'))
    }
    finish(data)
  }

  async function submitBackup(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { data, error } = await auth.twoFactor.verifyBackupCode({ code: code.trim() })
    setBusy(false)
    if (error) return setError(authErrorMessage(error, 'Неверный резервный код.'))
    finish(data)
  }

  return (
    <div className="flex w-full max-w-[400px] flex-col gap-3.5">
      <div className="text-xs font-semibold tracking-[0.06em] text-subtle uppercase">{STEP_LABEL[step]}</div>
      <Card className="flex flex-col gap-5 p-6 sm:p-8">
        {step === 'password' && (
          <form className="flex flex-col gap-5" onSubmit={submitPassword}>
            <Heading title="Вход в админку" subtitle="Один аккаунт, зарегистрироваться нельзя." />
            <Field id="email" label="Email">
              <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field id="password" label="Пароль">
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <ErrorText error={error} />
            <Button variant="primary" type="submit" className="w-full" disabled={busy}>
              Продолжить
            </Button>
            <div className="text-center text-xs text-subtle">Не больше 5 попыток входа за 15 минут</div>
          </form>
        )}

        {step === 'totp' && (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault()
              void submitTotp()
            }}
          >
            <Heading title="Код из приложения" subtitle="Введи 6 цифр из Google Authenticator или 1Password." />
            <CodeCells value={code} onChange={setCode} onComplete={(v) => void submitTotp(v)} disabled={busy} autoFocus />
            <ErrorText error={error} />
            <Button variant="primary" type="submit" className="w-full" disabled={busy || code.length !== 6}>
              Войти
            </Button>
            <div className="flex justify-between text-[13px]">
              <LinkButton onClick={() => go('password')}>Назад</LinkButton>
              <LinkButton muted onClick={() => go('backup')}>
                Резервный код
              </LinkButton>
            </div>
          </form>
        )}

        {step === 'backup' && (
          <form className="flex flex-col gap-5" onSubmit={submitBackup}>
            <Heading title="Резервный код" subtitle="Один из кодов, сохранённых при настройке 2FA. Каждый работает один раз." />
            <Field id="backup" label="Код">
              <Input id="backup" className="font-mono" autoComplete="off" required autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <ErrorText error={error} />
            <Button variant="primary" type="submit" className="w-full" disabled={busy || !code.trim()}>
              Войти
            </Button>
            <div className="text-[13px]">
              <LinkButton onClick={() => go('totp')}>Ввести код из приложения</LinkButton>
            </div>
          </form>
        )}

        {step === 'setup' && <TwoFactorSetup knownPassword={password} oauth={oauth} onDone={finish} />}
      </Card>
    </div>
  )
}

function TwoFactorSetup({ knownPassword, oauth, onDone }: { knownPassword: string; oauth: boolean; onDone: (data: unknown) => void }) {
  const auth = useAuthClient({ oauth })
  const [password, setPassword] = useState(knownPassword)
  const [totpURI, setTotpURI] = useState<string | null>(null)
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function start(pwd: string) {
    setBusy(true)
    setError(null)
    const { data, error } = await auth.twoFactor.enable({ password: pwd, issuer: 'Home Hub', method: 'totp' })
    setBusy(false)
    if (error || !data || data.method !== 'totp') return setError(authErrorMessage(error, 'Не получилось начать настройку.'))
    setTotpURI(data.totpURI)
    setBackupCodes(data.backupCodes)
  }

  useEffect(() => {
    if (knownPassword) void start(knownPassword)
    // Run once on mount with the password from step 1.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (totpURI) void QRCode.toDataURL(totpURI, { margin: 1, width: 180 }).then(setQr)
  }, [totpURI])

  async function verify(value = code) {
    if (value.length !== 6) return
    setBusy(true)
    setError(null)
    const { data, error } = await auth.twoFactor.verifyTotp({ code: value })
    setBusy(false)
    if (error) {
      setCode('')
      return setError(authErrorMessage(error, 'Неверный код.'))
    }
    onDone(data)
  }

  if (!totpURI) {
    return (
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          void start(password)
        }}
      >
        <Heading title="Включи второй фактор" subtitle="Без 2FA в админку не пустит. Подтверди пароль, чтобы начать." />
        <Field id="setup-password" label="Пароль">
          <Input id="setup-password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <Button variant="primary" type="submit" className="w-full" disabled={busy || !password}>
          Продолжить
        </Button>
      </form>
    )
  }

  const secret = new URL(totpURI).searchParams.get('secret') ?? ''

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        void verify()
      }}
    >
      <Heading title="Включи второй фактор" subtitle="Отсканируй QR-код в приложении-аутентификаторе и введи код из него." />
      <div className="flex items-center gap-4">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qr} alt="QR-код для приложения-аутентификатора" width={132} height={132} className="rounded-md bg-white" />
        ) : (
          <div className="size-[132px] rounded-md bg-secondary" />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-subtle">Или введи ключ вручную</span>
          <code className="font-mono text-xs break-all text-muted-foreground">{secret}</code>
        </div>
      </div>
      <details className="rounded-md border border-border bg-background px-3 py-2 text-[13px]">
        <summary className="cursor-pointer text-muted-foreground">Резервные коды — сохрани их сейчас</summary>
        <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">
          {backupCodes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      </details>
      <CodeCells value={code} onChange={setCode} onComplete={(v) => void verify(v)} disabled={busy} />
      <ErrorText error={error} />
      <Button variant="primary" type="submit" className="w-full" disabled={busy || code.length !== 6}>
        Включить и войти
      </Button>
    </form>
  )
}

function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-2xl">{title}</h1>
      <div className="text-muted-foreground">{subtitle}</div>
    </div>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <div role="alert" className="text-[13px] text-err">
      {error}
    </div>
  )
}

function LinkButton({ muted, onClick, children }: { muted?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={muted ? 'cursor-pointer text-subtle hover:text-muted-foreground' : 'cursor-pointer text-primary hover:text-primary-hover'}>
      {children}
    </button>
  )
}
