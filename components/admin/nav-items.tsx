import { Blocks, KeyRound, LayoutGrid, List, MoreHorizontal, PanelsTopLeft, SlidersHorizontal, SquareTerminal, type LucideIcon } from 'lucide-react'

export type NavItem = { path: string; label: string; short?: string; icon: LucideIcon }

export const NAV_ITEMS: NavItem[] = [
  { path: '/admin', label: 'Дашборд', icon: LayoutGrid },
  { path: '/admin/connectors', label: 'Коннекторы', icon: Blocks },
  { path: '/admin/prototypes', label: 'Прототипы', icon: PanelsTopLeft },
  { path: '/admin/scripts', label: 'Скрипты', icon: SquareTerminal },
  { path: '/admin/access', label: 'MCP доступ', short: 'MCP', icon: KeyRound },
  { path: '/admin/activity', label: 'Журнал', icon: List },
  { path: '/admin/settings', label: 'Настройки', icon: SlidersHorizontal },
]

// Bottom tabs on the phone; scripts, journal and settings live under «Ещё».
const TAB_PATHS = ['/admin', '/admin/connectors', '/admin/prototypes', '/admin/access']
export const MOBILE_TABS: NavItem[] = [
  ...NAV_ITEMS.filter((i) => TAB_PATHS.includes(i.path)),
  { path: '/admin/more', label: 'Ещё', icon: MoreHorizontal },
]

export const MORE_PATHS = ['/admin/more', '/admin/scripts', '/admin/activity', '/admin/settings']
