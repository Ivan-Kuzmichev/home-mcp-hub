import { LogoMark } from '@/components/logo'

/** Desktop: large title with subtitle and actions. Phone: compact top bar with the logo. */
export function PageHeader({
  title,
  subtitle,
  actions,
  mobileAside,
}: {
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  mobileAside?: React.ReactNode
}) {
  return (
    <>
      <header className="sticky top-0 z-10 -mx-4 -mt-4 mb-0 flex h-14 items-center gap-2.5 border-b border-border bg-background px-4 md:hidden">
        <LogoMark size={28} />
        <h1 className="flex-1 truncate text-[17px]">{title}</h1>
        {mobileAside}
      </header>
      <div className="hidden items-start justify-between gap-6 md:flex">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl">{title}</h1>
          {subtitle && <div className="text-[13px] text-subtle">{subtitle}</div>}
        </div>
        {actions && <div className="flex items-center gap-2.5">{actions}</div>}
      </div>
    </>
  )
}
