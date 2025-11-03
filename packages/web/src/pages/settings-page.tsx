import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/stores/app'
import { DEFAULT_CODEX_HOME, normalizeCodexHomeInput } from '@/stores/app/slices/app-settings.slice'
import { toast } from 'sonner'
import { http } from '@/lib/request'
import { fetchRuntimeSettings, updateRuntimeSettings } from '@/lib/api/settings'

const AGENT_OPTIONS = [{ id: 'codex', label: 'Codex' }]
const TAB_OPTIONS = [
  { id: 'general', label: '通用' },
  { id: 'agents', label: 'Agent' }
] as const

type VerifyDefaultResponse = {
  defaultDir: string | null
  authExists: boolean
  configExists: boolean
}

type Platform = 'windows' | 'mac' | 'linux' | 'other'

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('windows')) return 'windows'
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'mac'
  if (ua.includes('linux')) return 'linux'
  return 'other'
}

function resolveHomeShortcut(path: string, platform: Platform) {
  if (!path.startsWith('~')) return path
  const suffix = path.slice(1).replace(/^[/\\]+/, '')
  const separator = platform === 'windows' ? '\\' : '/'

  const home =
    platform === 'windows'
      ? `C:\\\\Users\\\\<用户名>`
      : platform === 'mac'
        ? '/Users/<用户名>'
        : platform === 'linux'
          ? '/home/<用户名>'
          : '<你的用户目录>'

  if (suffix.length === 0) return home
  const normalizedSuffix =
    platform === 'windows' ? suffix.replaceAll('/', '\\') : suffix.replaceAll('\\', '/')

  return `${home}${separator}${normalizedSuffix}`
}

export default function SettingsPage() {
  const [tab, setTab] = useState<(typeof TAB_OPTIONS)[number]['id']>('general')
  const [activeAgent, setActiveAgent] = useState(AGENT_OPTIONS[0]!.id)
  const codexHome = useAppStore((s) => s.codexHome)
  const setCodexHome = useAppStore((s) => s.setCodexHome)
  const [pendingCodexHome, setPendingCodexHome] = useState(codexHome)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [verifyStatus, setVerifyStatus] = useState<'idle' | 'success' | 'warning' | 'error'>('idle')
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null)

  const platform = useMemo(() => detectPlatform(), [])
  const resolvedCodexHome = useMemo(
    () => resolveHomeShortcut(pendingCodexHome, platform),
    [pendingCodexHome, platform]
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setLoadError(null)
      try {
        const data = await fetchRuntimeSettings()
        if (cancelled) return
        const sanitized = normalizeCodexHomeInput(data.codexHome ?? DEFAULT_CODEX_HOME)
        setCodexHome(sanitized)
        setPendingCodexHome(sanitized)
        setVerifyStatus('idle')
        setVerifyMessage(null)
      } catch (err: any) {
        if (cancelled) return
        setLoadError('加载设置失败')
        const message =
          err?.response?.data?.error?.message ??
          (typeof err?.message === 'string' ? err.message : '未知错误')
        toast.error(`加载设置失败：${message}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setCodexHome])

  useEffect(() => {
    setPendingCodexHome(codexHome)
    setVerifyStatus('idle')
    setVerifyMessage(null)
  }, [codexHome])

  const normalizedPendingCodexHome = useMemo(
    () => normalizeCodexHomeInput(pendingCodexHome),
    [pendingCodexHome]
  )
  const normalizedStoreCodexHome = useMemo(
    () => normalizeCodexHomeInput(codexHome),
    [codexHome]
  )
  const hasCodexHomeChanges = normalizedPendingCodexHome !== normalizedStoreCodexHome

  const handleSave = async () => {
    const sanitized = normalizeCodexHomeInput(pendingCodexHome)
    setSaving(true)
    try {
      const data = await updateRuntimeSettings({ codexHome: sanitized })
      const finalValue = normalizeCodexHomeInput(data.codexHome)
      setCodexHome(finalValue)
      setPendingCodexHome(finalValue)
      toast.success('设置已保存')
    } catch (err: any) {
      const message =
        err?.response?.data?.error?.message ??
        (typeof err?.message === 'string' ? err.message : '未知错误')
      toast.error(`保存失败：${message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleValidateDefaults = async () => {
    if (loading) return
    setVerifyLoading(true)
    setVerifyStatus('idle')
    setVerifyMessage(null)
    try {
      const res = await http.get<VerifyDefaultResponse>('/api/codex/default-credentials')
      const data = res.data
      if (!data.defaultDir) {
        setVerifyStatus('error')
        setVerifyMessage('无法定位默认用户目录，暂时无法校验凭证文件。')
        toast.error('无法定位默认用户目录')
        return
      }
      if (data.authExists && data.configExists) {
        const msg = `默认凭证完整：${data.defaultDir} 下已包含 auth.json 与 config.toml。`
        setVerifyStatus('success')
        setVerifyMessage(msg)
        toast.success('默认凭证已就绪')
      } else {
        const missing: string[] = []
        if (!data.authExists) missing.push('auth.json')
        if (!data.configExists) missing.push('config.toml')
        const msg = `${data.defaultDir} 缺少 ${missing.join('、')}，请先补齐再调整 CODEX_HOME。`
        setVerifyStatus('warning')
        setVerifyMessage(msg)
        toast.error(`默认凭证缺失：${missing.join('、')}`)
      }
    } catch (err: any) {
      const message =
        err?.response?.data?.error?.message ??
        (typeof err?.message === 'string' ? err.message : '未知错误')
      setVerifyStatus('error')
      setVerifyMessage('验证失败，请稍后重试。')
      toast.error(`验证失败：${message}`)
    } finally {
      setVerifyLoading(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-8 px-10 py-12">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">设置</h1>
        <p className="text-sm text-muted-foreground">管理 AI Loom 的全局偏好与运行时配置。</p>
      </div>
      <div className="space-y-2">
        {loading ? (
          <p className="text-sm text-muted-foreground">设置加载中...</p>
        ) : null}
        {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
      </div>
      <div className="flex h-full flex-1 gap-8 overflow-hidden">
        <div
          role="tablist"
          aria-orientation="vertical"
          className="flex h-full w-48 flex-col gap-2 rounded-xl border border-border/60 bg-muted/40 p-2"
        >
          {TAB_OPTIONS.map((item) => {
            const active = tab === item.id
            return (
              <button
                key={item.id}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={[
                  'flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-sm font-medium transition',
                  active
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                ].join(' ')}
              >
                {item.label}
              </button>
            )
          })}
        </div>
        <div className="flex-1 overflow-y-auto rounded-xl border border-border/70 bg-background/80 p-8 shadow-sm">
          {tab === 'general' ? (
            <div className="flex flex-col gap-6">
              <div className="space-y-2">
                <h2 className="text-xl font-semibold">通用设置</h2>
                <p className="text-sm text-muted-foreground">更多选项即将到来。</p>
              </div>
            </div>
          ) : null}
          {tab === 'agents' ? (
            <div className="flex flex-col gap-8">
              <div className="flex flex-col gap-1">
                <Label className="text-sm font-medium">选择 Agent</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-48 justify-between gap-2">
                      <span>
                        {AGENT_OPTIONS.find((agent) => agent.id === activeAgent)?.label ??
                          activeAgent}
                      </span>
                      <ChevronDown className="size-4 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-48">
                    <DropdownMenuRadioGroup value={activeAgent} onValueChange={setActiveAgent}>
                      {AGENT_OPTIONS.map((agent) => (
                        <DropdownMenuRadioItem key={agent.id} value={agent.id}>
                          {agent.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {activeAgent === 'codex' ? (
                <div className="flex flex-col gap-4">
                  <div className="space-y-2">
                    <h2 className="text-lg font-semibold">Codex 运行目录</h2>
                    <p className="text-sm text-muted-foreground">
                      设置本地 Codex 数据的根目录，默认值为 <code>~/.codex</code>。
                    </p>
                  </div>
                  <div className="flex flex-col gap-3">
                    <Label htmlFor="codex-home">CODEX_HOME</Label>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                      <Input
                        id="codex-home"
                        value={pendingCodexHome}
                        onChange={(event) => {
                          setPendingCodexHome(event.target.value)
                          setVerifyStatus('idle')
                          setVerifyMessage(null)
                        }}
                        placeholder="~/.codex"
                        spellCheck={false}
                        autoComplete="off"
                        className="sm:flex-1"
                        disabled={loading || saving}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleValidateDefaults}
                        disabled={verifyLoading || loading}
                        className="sm:w-auto"
                      >
                        {verifyLoading ? (
                          <>
                            <Loader2 className="mr-2 size-4 animate-spin" />
                            验证中...
                          </>
                        ) : (
                          '验证默认凭证'
                        )}
                      </Button>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      `~` 在{' '}
                      {platform === 'windows'
                        ? 'Windows'
                        : platform === 'mac'
                          ? 'macOS'
                          : platform === 'linux'
                            ? 'Linux'
                            : '当前系统'}{' '}
                      上会展开为用户目录。例如：
                      <span className="font-mono text-foreground/80">{resolvedCodexHome}</span>
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Windows 用户可填写 <code>C:\Users\&lt;用户名&gt;\.codex</code> 或{' '}
                      <code>%USERPROFILE%\.codex</code>；macOS 与 Linux 用户可直接使用{' '}
                      <code>~/.codex</code> 或替换为任意可写目录。
                    </p>
                    {verifyMessage ? (
                      <p
                        className={[
                          'text-xs leading-relaxed',
                          verifyStatus === 'success'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : verifyStatus === 'warning'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-destructive'
                        ].join(' ')}
                      >
                        {verifyMessage}
                      </p>
                    ) : null}
                    <div className="flex justify-end pt-2">
                      <Button
                        onClick={handleSave}
                        disabled={loading || saving || !hasCodexHomeChanges}
                      >
                        {saving ? (
                          <>
                            <Loader2 className="mr-2 size-4 animate-spin" />
                            保存中...
                          </>
                        ) : (
                          '保存'
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
