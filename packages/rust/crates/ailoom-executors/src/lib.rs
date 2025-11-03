//! Provider 无关的 per-conversation 运行时抽象。
//!
//! 该 crate 定义统一的 Provider 接口，使 CLI/子进程型与 HTTP API 型运行时
//! 能够以同样的生命周期接口被 RuntimeRegistry 管理。

use async_trait::async_trait;
use codex_protocol::{
    config_types::{ReasoningEffort, ReasoningSummary, SandboxMode},
    protocol::AskForApproval,
};
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;

pub mod providers;

/// 事件分发抽象，供执行器向上层广播 `chat.*` 与瞬时观测。
pub trait EventHub: Send + Sync {
    fn broadcast(&self, method: String, params: Value);
    fn broadcast_ephemeral(&self, method: String, params: Value);
}

pub type SharedEventHub = Arc<dyn EventHub>;

/// Provider 侧运行时错误类型。
#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("provider unavailable: {0}")]
    Unavailable(String),
    #[error("unsupported operation: {0}")]
    Unsupported(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("timeout after {0:?}")]
    Timeout(Duration),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("transport error: {0}")]
    Transport(String),
    #[error("other error: {0}")]
    Other(String),
}

/// Provider 原生事件。（保留扩展能力，当前未使用）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum ProviderRawEvent {
    Json(Value),
    TextLine(String),
    Binary(Vec<u8>),
}

/// 运行时状态枚举。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatus {
    Starting,
    Running,
    Busy,
    Idle,
    Terminating,
    Offline,
}

/// `/api/chat/runtime` 返回的快照结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeSnapshot {
    pub provider: String,
    pub conversation_id: String,
    pub status: RuntimeStatus,
    pub idle_ms: u64,
    pub pid: Option<u32>,
    pub generating: bool,
}

/// 创建会话时的配置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpawnConfig {
    pub model: Option<String>,
    pub options: Value,
}

/// 回合级覆盖配置。
#[derive(Debug, Clone)]
pub struct SandboxOverrides {
    pub mode: SandboxMode,
    pub writable_roots: Option<Vec<PathBuf>>,
    pub network_access: Option<bool>,
    pub exclude_tmpdir_env_var: Option<bool>,
    pub exclude_slash_tmp: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ConversationTurn {
    pub text: String,
    pub model: Option<String>,
    pub approval_policy: Option<AskForApproval>,
    pub sandbox: Option<SandboxOverrides>,
    pub effort: Option<ReasoningEffort>,
    pub summary: Option<ReasoningSummary>,
    pub cwd: Option<PathBuf>,
}

/// 统一 Provider 接口。
#[async_trait]
pub trait StandardProvider: Send + Sync {
    /// Provider 唯一 ID（例如 `codex`）。
    fn id(&self) -> &'static str;

    /// 创建新会话，返回 conversationId。
    async fn new_conversation(&self, config: SpawnConfig) -> Result<String, ProviderError>;

    /// 确保会话监听存在（resume/预热）。
    async fn ensure_listener(&self, conversation_id: &str) -> Result<(), ProviderError>;

    /// 发送用户消息。
    async fn send_user_message(
        &self,
        conversation_id: &str,
        text: &str,
    ) -> Result<(), ProviderError>;

    /// 发送带有配置覆盖的用户回合。
    async fn send_user_turn(
        &self,
        conversation_id: &str,
        turn: ConversationTurn,
    ) -> Result<(), ProviderError> {
        let _ = conversation_id;
        let _ = turn;
        Err(ProviderError::Unsupported(
            "send_user_turn not supported".into(),
        ))
    }

    /// 中断会话。
    async fn interrupt(&self, conversation_id: &str) -> Result<(), ProviderError>;

    /// 强制终止会话运行时。
    async fn terminate(&self, conversation_id: &str) -> Result<(), ProviderError>;

    /// 运行时是否仍存活。
    async fn is_alive(&self, conversation_id: &str) -> Result<bool, ProviderError> {
        let _ = conversation_id;
        Ok(false)
    }

    /// 运行时 pid（子进程 Provider 可实现）。
    async fn pid(&self, conversation_id: &str) -> Result<Option<u32>, ProviderError> {
        let _ = conversation_id;
        Ok(None)
    }

    /// 返回当前 provider 管理的会话快照。
    async fn runtime_snapshots(&self) -> Vec<RuntimeSnapshot>;

    /// Provider 原生事件流（当前默认不支持）。
    async fn subscribe_raw_events(
        &self,
        _conversation_id: &str,
    ) -> Result<Box<dyn Stream<Item = ProviderRawEvent> + Unpin + Send>, ProviderError> {
        Err(ProviderError::Unsupported(
            "raw event subscription not supported".into(),
        ))
    }
}

/// 线程安全的 Provider 引用类型。
pub type SharedProvider = std::sync::Arc<dyn StandardProvider>;
