'use client'

import { PanelLeftIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppSidebar } from '@/components/app-sidebar'

export function AppSidebarMobileTrigger() {
  const { toggleMobile } = useAppSidebar()
  return (
    <div className="sticky top-0 z-20 border-b border-border/60 bg-background/80 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="gap-2 text-sm"
        onClick={toggleMobile}
      >
        <PanelLeftIcon className="size-4" />
        导航
      </Button>
    </div>
  )
}
