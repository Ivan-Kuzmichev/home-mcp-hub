import { PageHeader } from '@/components/admin/page-header'
import { PrototypeList } from '@/components/prototypes/prototype-list'
import { UploadButton } from '@/components/prototypes/upload-form'
import { formatSize, plural } from '@/lib/connectors/format'
import { listPrototypes, totalSize } from '@/lib/prototypes/store'

export const dynamic = 'force-dynamic'

export default function PrototypesPage() {
  const items = listPrototypes()
  return (
    <>
      <PageHeader
        title="Прототипы"
        subtitle="HTML-страницы, которые Claude опубликовал через MCP. Ссылки открываются без входа, при желании — по пинкоду."
        actions={<UploadButton />}
      />
      <div className="md:hidden">
        <UploadButton />
      </div>
      <PrototypeList items={items} />
      <div className="flex flex-wrap justify-between gap-2 px-1 text-xs text-subtle">
        <span>
          {items.length} {plural(items.length, ['прототип', 'прототипа', 'прототипов'])} · {formatSize(totalSize())} на диске
        </span>
        <span>Истёкшие удаляются через 7 дней</span>
      </div>
    </>
  )
}
