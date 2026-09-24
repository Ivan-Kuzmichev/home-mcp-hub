import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-border bg-secondary text-secondary-foreground hover:bg-muted',
        primary: 'border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover',
        ghost: 'border-transparent bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground',
        destructive: 'border-err/40 bg-err/10 text-err hover:bg-err/20',
      },
      size: {
        default: 'h-10 px-4 text-sm',
        sm: 'h-[34px] rounded-sm px-3 text-[13px]',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
