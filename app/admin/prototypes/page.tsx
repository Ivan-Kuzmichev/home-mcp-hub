import { PageHeader } from '@/components/admin/page-header'
import { PrototypeList } from '@/components/prototypes/prototype-list'
import { UploadButton } from '@/components/prototypes/upload-form'
import { formatSize, plural } from '@/lib/connectors/format'
import { listPrototypes, totalSize } from '@/lib/prototypes/store'
import { requireAdmin } from '@/lib/session'
import { t } from '@/lib/i18n'

export const dynamic = 'force-dynamic'

export default async function PrototypesPage() {
  // Pages render in parallel with the layout: each one checks the session itself.
  await requireAdmin()
  const items = listPrototypes()
  return (
    <>
      <PageHeader
        title={t`Prototypes`}
        subtitle={t`HTML pages the assistant published through MCP. Links open without signing in, or with a PIN if you want.`}
        actions={<UploadButton />}
      />
      <div className="md:hidden">
        <UploadButton />
      </div>
      <PrototypeList items={items} />
      <div className="flex flex-wrap justify-between gap-2 px-1 text-xs text-subtle">
        <span>
          {items.length} {plural(items.length, ['prototype', 'prototypes'])} · {formatSize(totalSize())} {t`on disk`}
        </span>
        <span>{t`Expired ones are deleted after 7 days`}</span>
      </div>
    </>
  )
}
