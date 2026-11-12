'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { t } from '@/components/i18n-client'

type Tab = { id: string; label: string; steps: React.ReactNode[]; note?: React.ReactNode }

const Mono = ({ children }: { children: React.ReactNode }) => <span className="font-mono text-foreground">{children}</span>
const Ui = ({ children }: { children: React.ReactNode }) => <span className="font-medium text-foreground">{children}</span>

/** A function, not a constant: the texts must be built in the hub language at render time. */
const tabs = (): Tab[] => [
  {
    id: 'claude',
    label: 'Claude',
    steps: [
      <>{t`Turn on`} <Ui>{t`new client registration`}</Ui> {t`below.`}</>,
      <>
        {t`Claude (claude.ai or the desktop app) →`} <Ui>Settings</Ui> → <Ui>Connectors</Ui> → <Ui>Add custom connector</Ui>.
      </>,
      <>
        {t`Any name, for example`} <Mono>Home Hub</Mono>; URL — <Ui>MCP server URL</Ui> {t`above. Leave the OAuth fields empty →`} <Ui>Add</Ui>.
      </>,
      <>
        {t`Press`} <Ui>Connect</Ui>{t`: the hub page opens — sign in, enter the 2FA code, press`} <Ui>{t`“Allow”`}</Ui>.
      </>,
      <>
        {t`Client registration turns off by itself. In a new chat ask:`} <Mono>{t`call hub_status`}</Mono>.
      </>,
    ],
    note: t`A connector added on the web shows up in the Claude mobile app right away.`,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    steps: [
      <>{t`Turn on`} <Ui>{t`new client registration`}</Ui> {t`below.`}</>,
      <>
        ChatGPT → <Ui>{t`Plugins`}</Ui> → <Ui>{t`Add`}</Ui> → <Ui>{t`Create MCP app`}</Ui>.
      </>,
      <>
        {t`Name — for example`} <Mono>Home Hub</Mono>; <Ui>{t`Connection`}</Ui> → <Ui>{t`Server URL`}</Ui> — <Ui>MCP server URL</Ui> {t`above;`}
        <Ui>{t`Authentication`}</Ui> — <Ui>OAuth</Ui>{t`. Check`} <Ui>{t`“I understand and want to continue”`}</Ui> → <Ui>{t`Create`}</Ui>.
      </>,
      <>
        {t`The hub page opens — sign in, enter the 2FA code, press`} <Ui>{t`“Allow”`}</Ui>.
      </>,
      <>
        {t`Client registration turns off by itself. In a new chat ask:`} <Mono>{t`call hub_status`}</Mono>.
      </>,
    ],
    note: t`ChatGPT must be allowed in Allowed clients below (it is by default).`,
  },
]

export function ConnectTabs() {
  const TABS = tabs()
  const [active, setActive] = useState(TABS[0]!.id)
  const tab = TABS.find((x) => x.id === active) ?? TABS[0]!
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label={t`Client`} className="flex gap-1 self-start rounded-md border border-border bg-background p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            onClick={() => setActive(t.id)}
            className={cn('cursor-pointer rounded-sm px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground', t.id === active && 'bg-secondary text-foreground')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ol role="tabpanel" className="flex flex-col gap-2.5">
        {tab.steps.map((step, i) => (
          <li key={i} className="flex gap-2.5 text-[13px] leading-5 text-muted-foreground">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-foreground">{i + 1}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {tab.note && <p className="text-xs text-subtle">{tab.note}</p>}
    </div>
  )
}
