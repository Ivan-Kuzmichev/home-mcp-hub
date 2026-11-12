'use client'

import { X } from 'lucide-react'
import { useActionState, useState } from 'react'
import { saveCidrsAction, type CidrState } from '@/app/admin/access/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { t } from '@/components/i18n-client'

const CLAUDE_RANGE = '160.79.104.0/21'

export function CidrForm({ initial, trustProxy }: { initial: string[]; trustProxy: boolean }) {
  const [list, setList] = useState(initial)
  const [draft, setDraft] = useState('')
  const [state, action, pending] = useActionState<CidrState, FormData>(saveCidrsAction, {})
  const add = () => {
    const v = draft.trim()
    if (v && !list.includes(v)) setList([...list, v])
    setDraft('')
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="cidrs" value={list.join('\n')} />
      <div className="flex flex-wrap items-center gap-2">
        {list.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 rounded-full bg-muted py-1 pr-1.5 pl-2.5 font-mono text-xs text-muted-foreground">
            {c}
            <button type="button" aria-label={t`Remove ${c}`} className="cursor-pointer text-subtle hover:text-foreground" onClick={() => setList(list.filter((x) => x !== c))}>
              <X size={12} />
            </button>
          </span>
        ))}
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder={t`Add CIDR`}
          className="h-8 w-44 font-mono text-xs"
        />
        {!list.includes(CLAUDE_RANGE) && (
          <button type="button" className="cursor-pointer text-xs text-primary hover:text-primary-hover" onClick={() => setList([...list, CLAUDE_RANGE])}>
            {t`+ Claude (Anthropic) range`}
          </button>
        )}
      </div>
      {!trustProxy && list.length > 0 && (
        <span className="text-xs text-warn">{t`TRUST_PROXY is off: the hub does not see the real IP behind Pangolin, and the list will block everyone.`}</span>
      )}
      {state.error && <span className="text-xs text-err">{state.error}</span>}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending} onClick={add}>
          {t`Save`}
        </Button>
        {state.ok && <span className="text-xs text-ok">{state.ok}</span>}
      </div>
    </form>
  )
}
