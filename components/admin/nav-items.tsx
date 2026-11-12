import { Blocks, Stethoscope, KeyRound, LayoutGrid, List, MoreHorizontal, PanelsTopLeft, SlidersHorizontal, SquareTerminal, type LucideIcon } from 'lucide-react'

/** Labels are English; nav.tsx and the More page show them through tr(). */
export type NavItem = { path: string; label: string; short?: string; icon: LucideIcon }

export const NAV_ITEMS: NavItem[] = [
  { path: '/admin', label: 'Dashboard', icon: LayoutGrid },
  { path: '/admin/connectors', label: 'Connectors', icon: Blocks },
  { path: '/admin/prototypes', label: 'Prototypes', icon: PanelsTopLeft },
  { path: '/admin/scripts', label: 'Scripts', icon: SquareTerminal },
  { path: '/admin/access', label: 'MCP access', short: 'MCP', icon: KeyRound },
  { path: '/admin/activity', label: 'Activity', icon: List },
  { path: '/admin/diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { path: '/admin/settings', label: 'Settings', icon: SlidersHorizontal },
]

// Bottom tabs on the phone; scripts, journal, diagnostics and settings live under «Ещё».
const TAB_PATHS = ['/admin', '/admin/connectors', '/admin/prototypes', '/admin/access']
export const MOBILE_TABS: NavItem[] = [
  ...NAV_ITEMS.filter((i) => TAB_PATHS.includes(i.path)),
  { path: '/admin/more', label: 'More', icon: MoreHorizontal },
]

export const MORE_PATHS = ['/admin/more', '/admin/scripts', '/admin/activity', '/admin/diagnostics', '/admin/settings']
