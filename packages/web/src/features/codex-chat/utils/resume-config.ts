import type { ResumeConfigSnapshot } from '../services/api'
import type { AskForApproval } from '@/lib/codex-types/AskForApproval'
import type { SandboxMode } from '@/lib/codex-types/SandboxMode'
import type { CodexChatCapabilities } from '@/stores/codex-chat-provider'

const APPROVAL_VALUES: AskForApproval[] = ['on-request', 'on-failure', 'untrusted', 'never']
const SANDBOX_VALUES: SandboxMode[] = ['workspace-write', 'read-only', 'danger-full-access']

export type ResumeOverridePatch = {
  model?: string
  approvalPolicy?: AskForApproval
  sandboxMode?: SandboxMode
}

export function normalizeApproval(value?: string | null): AskForApproval | undefined {
  if (!value) return undefined
  return APPROVAL_VALUES.includes(value as AskForApproval)
    ? (value as AskForApproval)
    : undefined
}

export function normalizeSandbox(value?: string | null): SandboxMode | undefined {
  if (!value) return undefined
  return SANDBOX_VALUES.includes(value as SandboxMode) ? (value as SandboxMode) : undefined
}

export function deriveResumeOverrides(config?: ResumeConfigSnapshot | null): ResumeOverridePatch {
  if (!config) return {}
  const overrideModel = config.overrides?.model ?? config.model ?? undefined
  const overrideApproval = normalizeApproval(config.overrides?.approvalPolicy ?? config.approvalPolicy)
  const overrideSandbox = normalizeSandbox(config.overrides?.sandboxMode ?? config.sandbox?.mode)
  const patch: ResumeOverridePatch = {}
  if (overrideModel) patch.model = overrideModel
  if (overrideApproval) patch.approvalPolicy = overrideApproval
  if (overrideSandbox) patch.sandboxMode = overrideSandbox
  return patch
}

export function deriveResumeCapabilities(
  config?: ResumeConfigSnapshot | null
): Partial<CodexChatCapabilities> {
  if (!config) return {}
  return {
    providerId: 'codex',
    model: config.model ?? config.overrides?.model ?? undefined,
    extra: {
      resumeConfig: config
    }
  }
}
