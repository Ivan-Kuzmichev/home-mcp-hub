import { ChevronLeft } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/admin/page-header'
import { ConnectorForm } from '@/components/connectors/connector-form'
import { ConnectorList } from '@/components/connectors/connector-list'
import { EnabledSwitch } from '@/components/connectors/enabled-switch'
import { describeFields, describeTools, hubNetworks } from '@/lib/connectors/form'
import { getConnector } from '@/lib/connectors/registry'
import { getConnectorRow } from '@/lib/connectors/store'
import { connectorSummaries } from '@/lib/connectors/summary'
import { formatAgo } from '@/lib/format'
import { href } from '@/lib/prefix'

export const dynamic = 'force-dynamic'

export default async function ConnectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const c = getConnector(id)
  if (!c) notFound()
  const row = getConnectorRow(id)

  return (
    <>
      <div className="hidden md:block">
        <PageHeader title="Коннекторы" subtitle="Сервисы, к которым ИИ-ассистент получает доступ через хаб. Секреты хранятся зашифрованными." />
      </div>
      {/* Phone: the form is its own screen with a back button. */}
      <header className="sticky top-0 z-10 -mx-4 -mt-4 flex h-14 items-center gap-2 border-b border-border bg-background px-2 md:hidden">
        <Link href={href('/admin/connectors')} aria-label="Назад" className="flex size-10 items-center justify-center text-muted-foreground">
          <ChevronLeft size={22} />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-[17px]">{c.name}</h1>
          <span className="truncate text-xs text-subtle">{c.description}</span>
        </div>
        <EnabledSwitch id={c.id} name={c.name} enabled={row?.enabled ?? false} disabled={!row} />
      </header>

      <div className="grid gap-3.5 md:grid-cols-[320px_minmax(0,1fr)]">
        <div className="hidden md:block">
          <ConnectorList items={connectorSummaries()} selected={id} />
        </div>
        <ConnectorForm
          key={row?.updatedAt.getTime() ?? 'new'}
          id={c.id}
          name={c.name}
          description={c.description}
          docsUrl={c.docsUrl}
          fields={describeFields(c, row)}
          tools={describeTools(c)}
          disabledTools={row?.disabledTools ?? []}
          configured={!!row}
          lastCheck={row?.lastCheckAt ? { ok: !!row.lastCheckOk, note: row.lastCheckNote ?? '', ago: formatAgo(row.lastCheckAt) } : null}
          hubNetworks={hubNetworks()}
          backHref={href('/admin/connectors')}
        />
      </div>
    </>
  )
}
