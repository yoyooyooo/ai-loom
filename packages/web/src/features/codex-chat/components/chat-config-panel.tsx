import { useMemo } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { getCodexSessionState, useCodexChatProviderStore } from '@/stores/codex-chat-provider'

function booleanLabel(value: boolean | undefined) {
  if (value == null) return '未知'
  return value ? '已启用' : '未启用'
}

type CodexChatConfigPanelTriggerProps = {
  conversationId?: string
}

export function CodexChatConfigPanelTrigger({ conversationId }: CodexChatConfigPanelTriggerProps) {
  const session = useCodexChatProviderStore((state) => getCodexSessionState(state, conversationId))
  const { capabilities, overrides, models } = session

  const featureList = useMemo(() => {
    const entries: Array<{ label: string; enabled: boolean | undefined }> = [
      { label: '补丁', enabled: capabilities.features.patch },
      { label: '命令执行', enabled: capabilities.features.exec },
      { label: '模型列表', enabled: capabilities.features.modelsList },
      { label: '额度监控', enabled: capabilities.features.rateLimits },
      { label: '身份校验', enabled: capabilities.features.auth },
      { label: '工具调用', enabled: capabilities.features.toolCalls },
      { label: '图片工具', enabled: capabilities.features.images }
    ]
    return entries.filter((item) => item.enabled != null)
  }, [capabilities.features])

  const defaults = capabilities.defaults ?? {}
  const rateSnapshot = (capabilities.extra as any)?.rateLimitsSnapshot ?? null
  const primaryWindow = rateSnapshot?.primary ?? null
  const sessionConfigured = (capabilities.extra as any)?.sessionConfigured ?? null
  const effectiveModel = overrides.model ?? capabilities.model ?? defaults.model ?? '未绑定'
  const effectiveApproval = overrides.approvalPolicy ?? defaults.approvalPolicy ?? '未配置'
  const effectiveSandbox = overrides.sandboxMode ?? defaults.sandboxMode ?? '未配置'

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          配置 {capabilities.model ? `(${capabilities.model})` : ''}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[340px] sm:w-[420px]">
        <SheetHeader className="text-left">
          <SheetTitle>Codex 会话配置</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-6 text-sm leading-relaxed">
          <section>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">基础</h3>
            <div className="mt-2 space-y-2">
              <div>
                <span className="text-muted-foreground">模型：</span>
                <span>{capabilities.model ?? '未绑定'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">当前选择：</span>
                <span>{effectiveModel}</span>
              </div>
              <div>
                <span className="text-muted-foreground">默认审批策略：</span>
                <span>{defaults.approvalPolicy ?? '未配置'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">当前审批策略：</span>
                <span>{effectiveApproval}</span>
              </div>
              <div>
                <span className="text-muted-foreground">默认沙箱：</span>
                <span>{defaults.sandboxMode ?? '未配置'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">当前沙箱：</span>
                <span>{effectiveSandbox}</span>
              </div>
              <div>
                <span className="text-muted-foreground">身份状态：</span>
                <span>{booleanLabel(capabilities.authenticated)}</span>
              </div>
            </div>
          </section>

          <Separator />

          <section>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">可用能力</h3>
            <ul className="mt-2 space-y-1">
              {featureList.map((item) => (
                <li key={item.label} className="flex items-center justify-between">
                  <span>{item.label}</span>
                  <span className="text-muted-foreground">{booleanLabel(item.enabled)}</span>
                </li>
              ))}
            </ul>
          </section>

          <Separator />

          <section>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">模型列表</h3>
            <ul className="mt-2 space-y-1">
              {models.length === 0 ? (
                <li className="text-muted-foreground">暂无数据</li>
              ) : (
                models.map((model) => (
                  <li key={model.id} className="space-y-0.5">
                    <div className="font-medium">
                      {model.displayName || model.model}
                      {model.isDefault ? (
                        <span className="ml-2 rounded bg-muted px-1 text-xs text-muted-foreground">
                          默认
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {model.model}
                      {model.description ? ` · ${model.description}` : ''}
                    </div>
                  </li>
                ))
              )}
            </ul>
          </section>

          <Separator />

          <section>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">额度</h3>
            <div className="mt-2 space-y-2">
              <div>
                <span className="text-muted-foreground">剩余额度：</span>
                <span>
                  {capabilities.rateLimits?.remaining != null
                    ? `${capabilities.rateLimits.remaining}%`
                    : '未知'}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">重置时间：</span>
                <span>{capabilities.rateLimits?.resetAt ?? '未知'}</span>
              </div>
              {primaryWindow?.limit && (
                <div>
                  <span className="text-muted-foreground">窗口额度：</span>
                  <span>{primaryWindow.limit}</span>
                </div>
              )}
            </div>
          </section>

          {sessionConfigured && (
            <>
              <Separator />
              <section>
                <h3 className="text-xs font-semibold uppercase text-muted-foreground">会话信息</h3>
                <div className="mt-2 space-y-2">
                  <div>
                    <span className="text-muted-foreground">会话 ID：</span>
                    <span>{sessionConfigured.conversationId ?? sessionConfigured.sessionId}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Rollout：</span>
                    <span>{sessionConfigured.rolloutPath ?? '未知'}</span>
                  </div>
                  {sessionConfigured.historyEntryCount != null && (
                    <div>
                      <span className="text-muted-foreground">历史条目：</span>
                      <span>{sessionConfigured.historyEntryCount}</span>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
