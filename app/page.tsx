import { redirect } from 'next/navigation'
import { href } from '@/lib/prefix'

export const dynamic = 'force-dynamic'

// /{secret} → /{secret}/admin
export default function Home() {
  redirect(href('/admin'))
}
