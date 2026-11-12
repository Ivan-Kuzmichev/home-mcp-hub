import { PageHeader } from '@/components/admin/page-header'
import { ConnectorList } from '@/components/connectors/connector-list'
import { Card } from '@/components/ui/card'
import { connectorSummaries } from '@/lib/connectors/summary'
import { requireAdmin } from '@/lib/session'
import { t } from '@/lib/i18n'

export const dynamic = 'force-dynamic'

export default async function ConnectorsPage() {
  // Pages render in parallel with the layout: each one checks the session itself.
  await requireAdmin()
  return (
    <>
      <PageHeader title={t`Connectors`} subtitle={t`Services the AI assistant reaches through the hub. Secrets are stored encrypted.`} />
      <div className="grid gap-3.5 md:grid-cols-[320px_minmax(0,1fr)]">
        <ConnectorList items={connectorSummaries()} />
        <Card className="hidden items-center justify-center p-10 text-[13px] text-subtle md:flex">{t`Pick a connector to set it up`}</Card>
      </div>
    </>
  )
}
