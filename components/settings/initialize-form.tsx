'use client'

import { useState, useTransition } from 'react'
import { saveCustomInstructionsAction, type InitializeState } from '@/app/admin/settings/actions'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { t } from '@/components/i18n-client'

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
          label={t`Use custom instructions`}
          onChange={(on) => {
            setEnabled(on)
            setState({})
          }}
        />
        <span className="flex flex-col">
          <span>{t`Use custom instructions`}</span>
          <span className="text-xs text-subtle">
            {t`Instead of the instructions built from the connectors, the client gets this text, and the assistant takes the full rules from the tool`}{' '}
            <span className="font-mono">hub_guide</span>.
          </span>
        </span>
      </label>
      <textarea
        aria-label={t`Custom instructions`}
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
      <span className={cn('text-xs', over ? 'text-warn' : 'text-subtle')}>
        {text.trim().length} {t`chars`}{over && t` — over ${props.head}, ChatGPT may not read it all`}
      </span>
      {/* Phone: the message gets its own line above the buttons; wide screens: left of them. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {(state.ok || state.error) && <span className={cn('text-[13px] sm:flex-1', state.error ? 'text-err' : 'text-ok')}>{state.error ?? state.ok}</span>}
        <div className="flex gap-2 sm:ml-auto">
          <Button size="sm" disabled={!enabled || pending} onClick={() => setText(props.template)}>
            {t`Template`}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={pending}
            onClick={() => start(async () => setState(await saveCustomInstructionsAction(enabled, text)))}
          >
            {pending ? t`Saving…` : t`Save`}
          </Button>
        </div>
      </div>
    </div>
  )
}
