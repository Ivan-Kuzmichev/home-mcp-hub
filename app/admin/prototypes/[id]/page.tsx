import { ChevronLeft } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/admin/page-header'
import { PrototypeCard } from '@/components/prototypes/prototype-card'
import { PrototypeList } from '@/components/prototypes/prototype-list'
import { UploadButton } from '@/components/prototypes/upload-form'
import { href } from '@/lib/prefix'
import { getById, listPrototypes } from '@/lib/prototypes/store'
import { cardData } from '@/lib/prototypes/view'
import { requireAdmin } from '@/lib/session'
import { t } from '@/lib/i18n'

export const dynamic = 'force-dynamic'

export default async function PrototypePage({ params }: { params: Promise<{ id: string }> }) {
  // Pages render in parallel with the layout: each one checks the session itself.
  await requireAdmin()
  const { id } = await params
  const p = getById(id)
  if (!p) notFound()

  return (
    <>
      <div className="hidden md:block">
        <PageHeader title={t`Prototypes`} subtitle={t`HTML pages the assistant published through MCP.`} actions={<UploadButton />} />
      </div>
      <header className="sticky top-0 z-10 -mx-4 -mt-4 flex h-14 items-center gap-2 border-b border-border bg-background pr-4 pl-2 md:hidden">
        <Link href={href('/admin/prototypes')} aria-label={t`Back`} className="flex size-10 items-center justify-center text-muted-foreground">
          <ChevronLeft size={22} />
        </Link>
        <h1 className="truncate text-[17px]">{p.title}</h1>
      </header>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3.5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="hidden lg:block">
          <PrototypeList items={listPrototypes()} selected={p.id} compact />
        </div>
        <PrototypeCard key={`${p.id}-${p.updatedAt.getTime()}`} data={await cardData(p)} />
      </div>
    </>
  )
}
