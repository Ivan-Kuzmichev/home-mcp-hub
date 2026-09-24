'use client'

import { Upload } from 'lucide-react'
import { useActionState, useState } from 'react'
import { uploadPrototypeAction, type ActionState } from '@/app/admin/prototypes/actions'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function UploadButton() {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState<ActionState, FormData>(uploadPrototypeAction, {})
  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Upload size={14} /> Загрузить HTML вручную
      </Button>
    )
  }
  return (
    <Card className="w-full p-4">
      <form action={action} className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="up-file">HTML-файл, до 5 МБ</Label>
          <input id="up-file" name="file" type="file" accept=".html,.htm,text/html" required className="text-[13px] text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-sm file:border file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-foreground" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="up-title">Название</Label>
          <Input id="up-title" name="title" placeholder="по имени файла" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="up-pin">Пинкод</Label>
          <Input id="up-pin" name="pin" inputMode="numeric" pattern="\d{4,8}" placeholder="без пина" className="font-mono" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="up-exp">Срок жизни</Label>
          <select id="up-exp" name="expiry" className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="never">Бессрочно</option>
            <option value="7d">7 дней</option>
            <option value="30d">30 дней</option>
          </select>
        </div>
        <div className="flex items-end justify-end gap-2">
          <Button onClick={() => setOpen(false)}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Загружаю…' : 'Опубликовать'}
          </Button>
        </div>
        {state.error && <div className="text-[13px] text-err sm:col-span-2">{state.error}</div>}
      </form>
    </Card>
  )
}
