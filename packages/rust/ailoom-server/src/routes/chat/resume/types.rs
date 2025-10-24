use codex_protocol::config_types::SandboxMode;
use codex_protocol::protocol::{AskForApproval, SandboxPolicy, SessionMetaLine};
use crate::ws::chat_events::{ChatEvent, ChatHistoryEntry};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Deserialize, Default)]
pub struct ResumeBody {
    pub path: Option<String>,
    #[serde(rename = "conversationId")]
    pub conversation_id: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResumeQuery {
    #[serde(default)]
    pub include_history: Option<bool>,
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct FunctionCallOutputMetadata {
    #[serde(default)]
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub stderr: Option<String>,
    #[serde(default)]
    pub stdout: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct FunctionCallOutputEnvelope {
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub metadata: Option<FunctionCallOutputMetadata>,
}

#[derive(Debug, Clone, Default)]
pub struct TurnContextSnapshot {
    pub model: Option<String>,
    pub approval_policy: Option<AskForApproval>,
    pub sandbox_policy: Option<SandboxPolicy>,
    pub cwd: Option<PathBuf>,
    pub effort: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct EnvironmentContextSnapshot {
    pub cwd: Option<PathBuf>,
    pub approval_policy: Option<AskForApproval>,
    pub sandbox_mode: Option<SandboxMode>,
    pub network_access: Option<bool>,
    pub writable_roots: Vec<PathBuf>,
    pub shell: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RolloutConfigSnapshot {
    pub turn: Option<TurnContextSnapshot>,
    pub environment: Option<EnvironmentContextSnapshot>,
    pub session_meta: Option<SessionMetaLine>,
}

#[derive(Debug, Clone, Default)]
pub struct RolloutParseResult {
    pub history: Vec<ChatHistoryEntry>,
    pub snapshot: RolloutConfigSnapshot,
    pub events: Vec<(ChatEvent, Option<usize>)>,
}

#[derive(Default)]
pub struct ResumeOverrides {
    pub model: Option<String>,
    pub approval_policy: Option<AskForApproval>,
    pub sandbox_mode: Option<SandboxMode>,
    pub sandbox_policy: Option<SandboxPolicy>,
    pub config_map: HashMap<String, serde_json::Value>,
    pub cwd: Option<PathBuf>,
}

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSandboxConfig {
    pub mode: String,
    pub network_access: Option<bool>,
    pub exclude_tmpdir_env_var: Option<bool>,
    pub exclude_slash_tmp: Option<bool>,
    pub writable_roots: Option<Vec<String>>,
}

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResumeConfigResponse {
    pub model: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox: Option<ResumeSandboxConfig>,
    pub cwd: Option<String>,
    pub effort: Option<String>,
    pub summary: Option<String>,
    pub environment: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overrides: Option<ResumeOverridePayload>,
}

#[derive(serde::Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResumeOverridePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<HashMap<String, serde_json::Value>>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResumeEventPayload {
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeResponsePayload {
    pub conversation_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<ChatHistoryEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<ResumeEventPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<ResumeConfigResponse>,
}

