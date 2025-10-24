import type { ComponentType } from 'react'

export type ModuleNavItem = {
  id: string
  label: string
  icon?: ComponentType<{ className?: string }>
  path: string
  pill?: string
  enabled?: boolean
}

export type SidebarModuleConfig = ModuleNavItem[]

export function isModuleEnabled(item: ModuleNavItem): boolean {
  return item.enabled !== false
}
