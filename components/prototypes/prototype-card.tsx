'use client'

import { QrCode } from 'lucide-react'
import { useActionState, useState } from 'react'
import { deletePrototypeAction, rollbackAction, savePrototypeAction, uploadVersionAction, type ActionState } from '@/app/admin/prototypes/actions'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmButton } from '@/components/ui/confirm-button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Pill } from '@/components/ui/pill'
import { Switch } from '@/components/ui/switch'

export type CardData = {
  id: string
  title: string
  url: string
  qr: string
  meta: string
  hasPin: boolean
  expiryText: string
  expired: boolean
  currentVersion: number
  versions: { version: number; ago: string; size: string }[]
  previewUrl: string
}

export function PrototypeCard({ data }: { data: CardData }) {
  const [showQr, setShowQr] = useState(false)
  const [pinEnabled, setPinEnabled] = useState(data.hasPin)
  const [changingPin, setChangingPin] = useState(!data.hasPin)
  const [saveState, save, saving] = useActionState<ActionState, FormData>(savePrototypeAction, {})
  const [uploadState, upload, uploading] = useActionState<ActionState, FormData>(uploadVersionAction, {})

  return (
    <Card className="flex flex-col gap-5 p-4 pb-24 md:p-5 md:pb-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-lg">{data.title}</h2>
          <span className="text-[13px] text-subtle">{data.meta}</span>
        </div>
        {data.expired && <Pill tone="err">срок истёк · отвечает 410</Pill>}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="pt-link">Публичная ссылка</Label>
        <div className="flex gap-2">
          <Input id="pt-link" className="font-mono" value={data.url} readOnly />
          <CopyButton value={data.url} />
          <Button size="icon" className="size-10 shrink-0" aria-label="Показать QR" title="QR-код" onClick={() => setShowQr((v) => !v)}>
            <QrCode size={16} />
          </Button>
        </div>
        {showQr && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={data.qr} alt={`QR-код ссылки ${data.url}`} width={180} height={180} className="mt-2 rounded-md bg-white p-2" />
        )}
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <iframe
          title={`Превью: ${data.title}`}
          src={data.previewUrl}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          className="block h-64 w-full bg-white md:h-80"
          loading="lazy"
        />
      </div>

      <form action={save} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={data.id} />
        <input type="hidden" name="pinEnabled" value={pinEnabled ? 'on' : ''} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pt-title">Название</Label>
          <Input id="pt-title" name="title" defaultValue={data.title} />
        </div>

        <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-3.5">
          <div className="flex items-center gap-3">
            <Switch
              checked={pinEnabled}
              label="Пинкод включён"
              onChange={(v) => {
                setPinEnabled(v)
                if (v && !data.hasPin) setChangingPin(true)
              }}
            />
            <span className="flex-1 font-medium">
              Пинкод {pinEnabled && data.hasPin && !changingPin && <span className="font-mono text-muted-foreground">••••</span>}
            </span>
            {pinEnabled && data.hasPin && !changingPin && (
              <Button size="sm" onClick={() => setChangingPin(true)}>
                Сменить
              </Button>
            )}
          </div>
          {pinEnabled && changingPin && (
            <Input name="pin" inputMode="numeric" pattern="\d{4,8}" autoComplete="off" placeholder="Новый пин, 4–8 цифр" className="font-mono" required={!data.hasPin} />
          )}
          <span className="text-xs text-subtle">После ввода cookie на 24 ч · 5 попыток за 10 мин · смена пина сбрасывает все cookie</span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pt-exp">Срок жизни · сейчас {data.expiryText}</Label>
          <select id="pt-exp" name="expiry" defaultValue="keep" className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="keep">Не менять</option>
            <option value="never">Бессрочно</option>
            <option value="7d">7 дней от сегодня</option>
            <option value="30d">30 дней от сегодня</option>
          </select>
        </div>

        {saveState.error && <div className="text-[13px] text-err">{saveState.error}</div>}

        <div className="fixed inset-x-0 bottom-[calc(62px+max(18px,env(safe-area-inset-bottom)))] z-10 flex gap-2.5 border-t border-border bg-panel px-4 py-3 md:static md:justify-end md:border-0 md:bg-transparent md:p-0">
          {saveState.ok && <span className="hidden self-center text-[13px] text-ok md:inline">{saveState.ok}</span>}
          <Button type="submit" variant="primary" className="flex-1 md:flex-none" disabled={saving}>
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-2">
        <Label>Версии</Label>
        <div className="flex flex-col rounded-md border border-border">
          {data.versions.map((v) => (
            <div key={v.version} className="flex items-center gap-3 border-b border-divider px-3.5 py-2.5 text-[13px] last:border-b-0">
              <span className="w-10 font-mono">v{v.version}</span>
              <span className="flex-1 text-subtle">
                {v.ago} · {v.size}
              </span>
              <a href={`${data.previewUrl.split('?')[0]}?v=${v.version}`} target="_blank" rel="noreferrer" className="no-underline">
                открыть
              </a>
              {v.version === data.currentVersion ? (
                <Pill tone="ok">текущая</Pill>
              ) : (
                <form action={rollbackAction}>
                  <input type="hidden" name="id" value={data.id} />
                  <input type="hidden" name="version" value={v.version} />
                  <button type="submit" className="cursor-pointer text-primary hover:text-primary-hover">
                    откатить
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
        <form action={upload} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="id" value={data.id} />
          <input name="file" type="file" accept=".html,.htm,text/html" required className="min-w-0 flex-1 text-[13px] text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-sm file:border file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-foreground" />
          <Button type="submit" size="sm" disabled={uploading}>
            {uploading ? 'Загружаю…' : 'Загрузить новую версию'}
          </Button>
          {uploadState.error && <span className="w-full text-[13px] text-err">{uploadState.error}</span>}
          {uploadState.ok && <span className="w-full text-[13px] text-ok">{uploadState.ok}</span>}
        </form>
      </div>

      <div className="flex justify-start border-t border-divider pt-4">
        <ConfirmButton action={deletePrototypeAction} fields={{ id: data.id }} label="Удалить прототип" confirmLabel="Точно удалить" />
      </div>
    </Card>
  )
}
