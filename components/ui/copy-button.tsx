'use client'

import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

export function CopyButton({ value, label = 'Скопировать' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="icon"
      aria-label={label}
      title={label}
      className="size-10 shrink-0"
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check size={16} className="text-ok" /> : <Copy size={16} />}
    </Button>
  )
}
