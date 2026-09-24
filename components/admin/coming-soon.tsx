import { PageHeader } from '@/components/admin/page-header'
import { Card } from '@/components/ui/card'

export function ComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card className="flex flex-col gap-1.5 p-5">
        <div className="font-medium">Раздел пока пустой</div>
        <div className="text-muted-foreground">{description}</div>
      </Card>
    </>
  )
}
