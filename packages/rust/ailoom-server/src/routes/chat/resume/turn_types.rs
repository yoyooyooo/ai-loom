use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/src/features/codex-chat/types/generated/turns.ts"
    )
)]
pub struct Turn {
    pub id: String,
    pub seq: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    pub status: TurnStatus,
    pub user: TurnUser,
    pub assistant: TurnAssistant,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<TurnReasoning>,
    pub steps: Vec<TurnStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | null | undefined")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/src/features/codex-chat/types/generated/turns.ts"
    )
)]
pub struct TurnUser {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/src/features/codex-chat/types/generated/turns.ts"
    )
)]
pub struct TurnAssistant {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/src/features/codex-chat/types/generated/turns.ts"
    )
)]
pub struct TurnReasoning {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, TurnReasoningItem> | null | undefined")]
    pub items: Option<HashMap<String, TurnReasoningItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_item_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/src/features/codex-chat/types/generated/turns.ts"
    )
)]
pub struct TurnReasoningItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/src/features/codex-chat/types/generated/turns.ts"
    )
)]
pub struct TurnStep {
    pub id: String,
    pub kind: TurnStepKind,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    pub status: TurnStepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "Record<string, unknown> | null | undefined")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/src/features/codex-chat/types/generated/turns.ts"
    )
)]
pub enum TurnStepKind {
    Read,
    List,
    Search,
    Exec,
    Patch,
    Mcp,
    Info,
    Thinking,
    Plan,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/src/features/codex-chat/types/generated/turns.ts"
    )
)]
pub enum TurnStepStatus {
    Streaming,
    Completed,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(
    export,
    export_to = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../web/src/features/codex-chat/types/generated/turns.ts"
    )
)]
pub enum TurnStatus {
    Streaming,
    Completed,
    Failed,
    Aborted,
}
