import { cn } from '@/lib/utils'

export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  const icon = Math.round(size * 0.56)
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center bg-primary text-primary-foreground', className)}
      style={{ width: size, height: size, borderRadius: size >= 32 ? 9 : 8 }}
    >
      <svg width={icon} height={icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
      </svg>
    </div>
  )
}
