import { PageHeader } from '@/components/admin/page-header'
import { ConnectorList } from '@/components/connectors/connector-list'
import { Card } from '@/components/ui/card'
import { connectorSummaries } from '@/lib/connectors/summary'

export const dynamic = 'force-dynamic'

export default function ConnectorsPage() {
  return (
    <>
      <PageHeader title="Коннекторы" subtitle="Сервисы, к которым ИИ-ассистент получает доступ через хаб. Секреты хранятся зашифрованными." />
      <div className="grid gap-3.5 md:grid-cols-[320px_minmax(0,1fr)]">
        <ConnectorList items={connectorSummaries()} />
        <Card className="hidden items-center justify-center p-10 text-[13px] text-subtle md:flex">Выбери коннектор, чтобы настроить его</Card>
      </div>
    </>
  )
}
