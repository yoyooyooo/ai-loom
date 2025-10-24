'use client'

import { createContext, useContext, useMemo, useState, useEffect, type ReactNode } from 'react'
import { Command } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ModuleNavItem, SidebarModuleConfig } from '@/components/app-sidebar-config'
import { isModuleEnabled } from '@/components/app-sidebar-config'
import { useIsMobile } from '@/hooks/use-mobile'
import { ThemeToggle } from '@/components/theme-toggle'

export type AppSidebarProps = {
  modules: SidebarModuleConfig
  activeModuleId?: string
  onNavigate: (path: string, item: ModuleNavItem) => void
  children?: ReactNode
  className?: string
}

type AppSidebarContextValue = {
  isMobile: boolean
  openMobile: boolean
  toggleMobile: () => void
  closeMobile: () => void
}

const AppSidebarContext = createContext<AppSidebarContextValue | null>(null)

export function useAppSidebar() {
  const ctx = useContext(AppSidebarContext)
  if (!ctx) throw new Error('useAppSidebar must be used within AppSidebar')
  return ctx
}

export function AppSidebar({
  modules,
  activeModuleId,
  onNavigate,
  children,
  className
}: AppSidebarProps) {
  const enabledModules = modules.filter(isModuleEnabled)
  const active = enabledModules.find((item) => item.id === activeModuleId) ?? enabledModules[0]
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = useState(false)

  useEffect(() => {
    if (!isMobile) setOpenMobile(false)
  }, [isMobile])

  const context = useMemo<AppSidebarContextValue>(
    () => ({
      isMobile,
      openMobile,
      toggleMobile: () => setOpenMobile((prev) => !prev),
      closeMobile: () => setOpenMobile(false)
    }),
    [isMobile, openMobile]
  )

  return (
    <AppSidebarContext.Provider value={context}>
      <div className={cn('relative flex h-full w-full overflow-hidden bg-background', className)}>
        {isMobile && openMobile ? (
          <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setOpenMobile(false)} />
        ) : null}
        <aside
          className={cn(
            'z-50 flex h-full flex-col border-r border-border transition-transform duration-200 ease-in-out',
            isMobile
              ? cn(
                  'fixed inset-y-0 left-0 w-56 bg-background px-4 py-4 shadow-lg',
                  openMobile ? 'translate-x-0' : '-translate-x-full'
                )
              : 'w-14 items-center bg-muted/40 px-2 py-4'
          )}
        >
          <PrimaryNavigation
            modules={enabledModules}
            activeModuleId={active?.id}
            onNavigate={(path, item) => {
              if (isMobile) setOpenMobile(false)
              onNavigate(path, item)
            }}
            isMobile={isMobile}
          />
          <div className={cn('mt-auto w-full', isMobile ? 'pt-6' : 'pt-4')}>
            <ThemeToggle showLabel={isMobile} className={isMobile ? undefined : 'mx-auto'} />
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col bg-background">
          {children ?? <div className="flex-1" />}
        </main>
      </div>
    </AppSidebarContext.Provider>
  )
}

type PrimaryNavigationProps = {
  modules: ModuleNavItem[]
  activeModuleId?: string
  onNavigate: (path: string, item: ModuleNavItem) => void
  isMobile: boolean
}

function PrimaryNavigation({
  modules,
  activeModuleId,
  onNavigate,
  isMobile
}: PrimaryNavigationProps) {
  return (
    <nav className={cn('flex w-full flex-col gap-3', isMobile ? '' : 'items-center')}>
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-1 text-sm font-semibold text-foreground',
          isMobile ? 'justify-start' : 'size-10 items-center justify-center'
        )}
      >
        <span
          className={cn(
            'flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground',
            !isMobile && 'size-10'
          )}
        >
          <Command className="size-4" />
        </span>
        {isMobile ? <span className="text-sm">AI Loom</span> : null}
      </div>
      <div className={cn('flex flex-col gap-1', isMobile ? '' : 'w-full')}>
        {modules.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.path, item)}
            title={item.label}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted hover:text-foreground',
              activeModuleId === item.id
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground',
              isMobile ? 'justify-start' : 'w-10 flex-col gap-1 px-0 py-2'
            )}
          >
            {item.icon ? (
              <item.icon className="size-4" />
            ) : (
              <span className="flex size-8 items-center justify-center rounded-md bg-muted text-xs font-semibold uppercase">
                {item.label.slice(0, 1)}
              </span>
            )}
            {isMobile ? <span className="truncate text-sm">{item.label}</span> : null}
            {!isMobile && item.pill ? (
              <span className="text-[10px] text-primary">{item.pill}</span>
            ) : null}
          </button>
        ))}
      </div>
    </nav>
  )
}

type ThemeToggleButtonProps = {
  isMobile: boolean
}

export default AppSidebar
