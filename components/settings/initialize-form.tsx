'use client'

import { useState, useTransition } from 'react'
import { saveCustomInstructionsAction, type InitializeState } from '@/app/admin/settings/actions'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

type Props = { enabled: boolean; text: string; template: string; head: number }

export function InitializeForm(props: Props) {
  const [enabled, setEnabled] = useState(props.enabled)
  // Prefilled with the template until the admin saves a text of their own.
  const [text, setText] = useState(props.text || props.template)
  const [state, setState] = useState<InitializeState>({})
  const [pending, start] = useTransition()
  const over = text.trim().length > props.head

  return (
    <div className="flex flex-col gap-3">
      <label className="flex cursor-pointer items-start gap-3">
        <Switch
          checked={enabled}
          label="Использовать свою инструкцию"
          onChange={(on) => {
            setEnabled(on)
            setState({})
          }}
        />
        <span className="flex flex-col">
          <span>Использовать свою инструкцию</span>
          <span className="text-xs text-subtle">
            Вместо инструкций, собранных из коннекторов, клиент получит этот текст, а полные правила ассистент возьмёт из инструмента{' '}
            <span className="font-mono">hub_guide</span>.
          </span>
        </span>
      </label>
      <textarea
        aria-label="Своя инструкция"
        rows={6}
        disabled={!enabled}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setState({})
        }}
        className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] leading-5 text-foreground placeholder:text-faint focus-visible:border-primary focus-visible:outline-none disabled:opacity-50"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={cn('text-xs', over ? 'text-warn' : 'text-subtle')}>
          {text.trim().length} симв.{over ? ` — больше ${props.head}, ChatGPT может не дочитать` : ` · укладывается в ${props.head} для ChatGPT`}
        </span>
        <div className="flex items-center gap-2">
          {(state.ok || state.error) && <span className={state.error ? 'text-[13px] text-err' : 'text-[13px] text-ok'}>{state.error ?? state.ok}</span>}
          <Button size="sm" disabled={!enabled || pending} onClick={() => setText(props.template)}>
            Шаблон
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={pending}
            onClick={() => start(async () => setState(await saveCustomInstructionsAction(enabled, text)))}
          >
            {pending ? 'Сохраняю…' : 'Сохранить'}
          </Button>
        </div>
      </div>
    </div>
  )
}
