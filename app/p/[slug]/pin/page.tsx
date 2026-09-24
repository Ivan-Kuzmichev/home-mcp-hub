import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { PinForm } from '@/components/prototypes/pin-form'
import { accessCookieName, verifyAccess } from '@/lib/prototypes/access'
import { SLUG_PATTERN } from '@/lib/prototypes/http'
import { getBySlug, isExpired } from '@/lib/prototypes/store'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const p = SLUG_PATTERN.test(slug) ? getBySlug(slug) : undefined
  return { title: p ? `${p.title} — пинкод` : 'Прототип', robots: { index: false, follow: false } }
}

export default async function PinPage({ params }: Props) {
  const { slug } = await params
  const p = SLUG_PATTERN.test(slug) ? getBySlug(slug) : undefined
  if (!p) notFound()
  // No pin, expired (410) or already unlocked: the prototype route decides.
  if (!p.pinHash || isExpired(p) || verifyAccess((await cookies()).get(accessCookieName(slug))?.value, p)) redirect(`/p/${slug}`)

  const host = new URL(process.env.BASE_URL ?? 'http://localhost').host
  return (
    <div className="flex min-h-dvh flex-col px-5 py-6 sm:px-10 sm:py-8">
      <div className="hidden font-mono text-xs text-subtle sm:block">
        {host}/p/{slug}
      </div>
      <main className="flex flex-1 items-center justify-center">
        <PinForm slug={slug} title={p.title} />
      </main>
      <div className="hidden justify-end font-mono text-xs text-faint sm:flex">noindex</div>
    </div>
  )
}
