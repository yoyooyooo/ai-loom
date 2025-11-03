'use client'

import { createContext, useContext, useMemo, useState, useEffect, type ReactNode } from 'react'
import { Command, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ModuleNavItem, SidebarModuleConfig } from '@/components/app-sidebar-config'
import { isModuleEnabled } from '@/components/app-sidebar-config'
import { useIsMobile } from '@/hooks/use-mobile'
import { ThemeToggle } from '@/components/theme-toggle'
import { GlobalGeneratingIndicator } from '@/components/global-generating-indicator'

export type AppSidebarProps = {
  modules: SidebarModuleConfig
  activeModuleId?: string
  onNavigate: (path: string, item: ModuleNavItem) => void
  onOpenSettings?: () => void
  settingsActive?: boolean
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
  onOpenSettings,
  settingsActive,
  children,
  className
}: AppSidebarProps) {
  const enabledModules = modules.filter(isModuleEnabled)
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = useState(false)

  useEffect(() => {
    if (!isMobile) setOpenMobile(false)
  }, [isMobile])

  const handleOpenSettings = () => {
    if (!onOpenSettings) return
    if (isMobile) setOpenMobile(false)
    onOpenSettings()
  }

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
            activeModuleId={activeModuleId}
            onNavigate={(path, item) => {
              if (isMobile) setOpenMobile(false)
              onNavigate(path, item)
            }}
            isMobile={isMobile}
          />
          <div className={cn('mt-auto w-full', isMobile ? 'pt-6' : 'pt-4')}>
            {/* 全局进行中指标（置于主题切换上方） */}
            <div className={cn('mb-2 flex', isMobile ? '' : 'justify-center')}>
              <GlobalGeneratingIndicator showLabel={isMobile} />
            </div>
            {onOpenSettings ? (
              <div className={cn('mb-2 flex', isMobile ? '' : 'justify-center')}>
                <SettingsButton
                  active={Boolean(settingsActive)}
                  showLabel={isMobile}
                  onClick={handleOpenSettings}
                />
              </div>
            ) : null}
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
          'flex items-center text-sm font-semibold text-foreground',
          isMobile ? 'gap-2 px-3 py-2' : 'flex-col gap-3'
        )}
      >
        <span
          className={cn(
            'flex aspect-square items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm',
            isMobile ? 'size-8' : 'size-10'
          )}
        >
          <Command className={isMobile ? 'size-4' : 'size-5'} />
        </span>
        {isMobile ? <span className="text-sm">AI Loom</span> : null}
      </div>
      <div className={cn('flex flex-col gap-1', isMobile ? 'px-1' : 'w-full items-center gap-2')}>
        {modules.map((item) => {
          const Icon = item.icon
          const isActive = activeModuleId === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.path, item)}
              title={item.label}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'group relative flex items-center rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isMobile
                  ? 'justify-start gap-3 px-3 py-2 hover:bg-muted'
                  : 'aspect-square w-12 justify-center p-0 hover:bg-muted/30',
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <span
                className={cn(
                  'flex aspect-square w-9 items-center justify-center rounded-lg border text-base transition-colors',
                  isActive
                    ? 'border-primary/50 bg-primary text-primary-foreground shadow-sm'
                    : 'border-transparent bg-muted text-muted-foreground group-hover:border-border/60 group-hover:text-foreground'
                )}
              >
                {Icon ? (
                  <Icon className="size-5" />
                ) : (
                  <span className="text-xs font-semibold uppercase">{item.label.slice(0, 1)}</span>
                )}
              </span>
              {isMobile ? <span className="truncate text-sm">{item.label}</span> : null}
              {!isMobile && item.pill ? (
                <span className="absolute bottom-1 text-[10px] text-primary">{item.pill}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

type SettingsButtonProps = {
  active: boolean
  showLabel: boolean
  onClick: () => void
}

function SettingsButton({ active, showLabel, onClick }: SettingsButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      aria-label="设置"
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full border border-border/60 bg-background text-xs text-muted-foreground shadow-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        showLabel ? 'w-full justify-start px-3 py-2' : 'size-10',
        active ? 'border-primary/70 text-foreground shadow-md' : ''
      )}
      title="设置"
    >
      <Settings className={showLabel ? 'size-4' : 'size-5'} />
      {showLabel ? <span className="text-xs font-medium">设置</span> : null}
    </button>
  )
}

export default AppSidebar
