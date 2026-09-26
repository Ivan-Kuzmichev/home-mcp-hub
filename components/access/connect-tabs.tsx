'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

type Tab = { id: string; label: string; steps: React.ReactNode[]; note?: React.ReactNode }

const Mono = ({ children }: { children: React.ReactNode }) => <span className="font-mono text-foreground">{children}</span>
const Ui = ({ children }: { children: React.ReactNode }) => <span className="font-medium text-foreground">{children}</span>

const TABS: Tab[] = [
  {
    id: 'claude',
    label: 'Claude',
    steps: [
      <>Включи <Ui>регистрацию новых клиентов</Ui> ниже.</>,
      <>
        Claude (claude.ai или приложение для компьютера) → <Ui>Settings</Ui> → <Ui>Connectors</Ui> → <Ui>Add custom connector</Ui>.
      </>,
      <>
        Имя — любое, например <Mono>Home Hub</Mono>; URL — <Ui>MCP server URL</Ui> выше. OAuth-поля не заполняй → <Ui>Add</Ui>.
      </>,
      <>
        Нажми <Ui>Connect</Ui>: откроется страница хаба — войди, введи код 2FA, нажми <Ui>«Разрешить»</Ui>.
      </>,
      <>
        Регистрация клиентов выключится сама. В новом чате попроси: <Mono>вызови hub_status</Mono>.
      </>,
    ],
    note: 'Коннектор, добавленный в вебе, сразу появится в мобильном приложении Claude.',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    steps: [
      <>Включи <Ui>регистрацию новых клиентов</Ui> ниже.</>,
      <>
        ChatGPT в браузере → <Ui>Settings</Ui> → <Ui>Apps &amp; Connectors</Ui> → <Ui>Advanced settings</Ui> → включи <Ui>Developer mode</Ui>.
      </>,
      <>
        Вернись в <Ui>Apps &amp; Connectors</Ui> → <Ui>Create</Ui>: имя — например <Mono>Home Hub</Mono>, <Ui>MCP Server URL</Ui> — адрес выше,
        Authentication — <Ui>OAuth</Ui>; подтверди, что доверяешь приложению → <Ui>Create</Ui>.
      </>,
      <>
        Откроется страница хаба — войди, введи код 2FA, нажми <Ui>«Разрешить»</Ui>.
      </>,
      <>
        Регистрация клиентов выключится сама. В новом чате включи коннектор (<Ui>+</Ui> → Developer mode → Home Hub) и попроси:{' '}
        <Mono>вызови hub_status</Mono>.
      </>,
    ],
    note: 'ChatGPT должен быть разрешён в «Разрешённых клиентах» ниже (по умолчанию включён).',
  },
]

export function ConnectTabs() {
  const [active, setActive] = useState(TABS[0]!.id)
  const tab = TABS.find((t) => t.id === active) ?? TABS[0]!
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Клиент" className="flex gap-1 self-start rounded-md border border-border bg-background p-1">
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
