'use client'

import { createContext, useCallback, useContext } from 'react'

const PrefixContext = createContext<string | null>(null)

export function PrefixProvider({ prefix, children }: { prefix: string; children: React.ReactNode }) {
  return <PrefixContext.Provider value={prefix}>{children}</PrefixContext.Provider>
}

export function usePrefix(): string {
  const prefix = useContext(PrefixContext)
  if (!prefix) throw new Error('usePrefix must be used inside PrefixProvider')
  return prefix
}

/** Client-side counterpart of href() from lib/prefix.ts. */
export function useHref(): (path: string) => string {
  const prefix = usePrefix()
  return useCallback((path: string) => {
    const clean = path.startsWith('/') ? path : `/${path}`
    return clean === '/' ? `/${prefix}` : `/${prefix}${clean}`
  }, [prefix])
}
