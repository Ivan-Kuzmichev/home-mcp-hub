import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { NAV_ITEMS } from '@/components/admin/nav-items'
import { PageHeader } from '@/components/admin/page-header'
import { SignOutButton } from '@/components/admin/sign-out-button'
import { Card } from '@/components/ui/card'
import { href } from '@/lib/prefix'

// Phone-only «Ещё» tab: sections that do not fit into the bottom bar.
const MORE = NAV_ITEMS.filter((i) => i.path === '/admin/activity' || i.path === '/admin/settings')

export default function MorePage() {
  return (
    <>
      <PageHeader title="Ещё" />
      <Card className="flex flex-col px-3.5">
        {MORE.map(({ path, label, icon: Icon }) => (
          <Link key={path} href={href(path)} className="flex items-center gap-3 border-b border-divider py-3.5 text-foreground no-underline hover:text-foreground">
            <Icon size={18} className="text-subtle" />
            <span className="flex-1">{label}</span>
            <ChevronRight size={16} className="text-subtle" />
          </Link>
        ))}
        <SignOutButton withLabel className="gap-3 py-3.5 text-sm" />
      </Card>
    </>
  )
}
