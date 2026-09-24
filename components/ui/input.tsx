import * as React from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-faint focus-visible:border-primary focus-visible:outline-none disabled:opacity-50 aria-invalid:border-err',
        className,
      )}
      {...props}
    />
  )
}
