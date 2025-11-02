use crate::state::AppState;
use crate::ws::chat_events::{event, ChatEvent};
use axum::{http::StatusCode, response::IntoResponse, Json};
use codex_protocol::{config_types::SandboxMode, protocol::AskForApproval};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use ailoom_executors::SpawnConfig;

use ailoom_executors::providers::codex::store_conversation_id;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewConversationRequest {
    pub model: Option<String>,
    pub approval_policy: Option<AskForApproval>,
    pub sandbox_mode: Option<SandboxMode>,
    /// 可选：首条用户消息。提供该字段时，将在创建会话后立即发送，避免“只建不跑”。
    pub text: Option<String>,
    pub provider: Option<String>,
}

pub async fn new_conversation(
    axum::extract::State(state): axum::extract::State<AppState>,
    body: Option<Json<NewConversationRequest>>,
) -> impl IntoResponse {
    // 每会话子进程：spawn_new → newConversation → ensure_listener
    let req = body.map(|Json(inner)| inner).unwrap_or_default();
    let provider = req.provider.clone().unwrap_or_else(|| "codex".to_string());

    let mut options = Map::new();
    if let Some(policy) = req.approval_policy.clone() {
        options.insert(
            "approvalPolicy".into(),
            serde_json::to_value(policy).unwrap_or(Value::Null),
        );
    }
    if let Some(sandbox) = req.sandbox_mode.clone() {
        options.insert(
            "sandbox".into(),
            serde_json::to_value(sandbox).unwrap_or(Value::Null),
        );
    }

    let spawn_config = SpawnConfig {
        model: req.model.clone(),
        options: if options.is_empty() {
            Value::Null
        } else {
            Value::Object(options)
        },
    };

    let conversation_id = match state
        .runtime_registry
        .new_conversation(&provider, spawn_config)
        .await
    {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!(target:"provider", provider=%provider, error=%e, "spawn_new 失败");
            return (StatusCode::BAD_GATEWAY, format!("启动会话失败：{}", e)).into_response();
        }
    };
    tracing::info!(target:"provider", provider=%provider, conversationId=%conversation_id, "HTTP /api/chat/conversations → OK");
    if provider == "codex" {
        store_conversation_id(&conversation_id);
    }
    // Broadcast session.new for UI to bind
    if let Some(hub) = state.ws_hub.clone() {
        let (m, p) = event(ChatEvent::SessionNew {
            conversation_id: conversation_id.clone(),
        });
        hub.broadcast(m, p);
    }
    // 若附带首条消息，则在后台立即发送，避免“只创建不执行”的空窗
    if let Some(text) = req
        .text
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        // 立即向前端回显（入环），让 UI 不空窗
        if let Some(hub) = state.ws_hub.clone() {
            hub.broadcast(
                "chat.info.user_message".into(),
                json!({"conversationId": conversation_id, "text": text}),
            );
        }
        let cid = conversation_id.clone();
        let payload = text.clone();
        let provider_clone = provider.clone();
        let runtime_registry = state.runtime_registry.clone();
        tokio::spawn(async move {
            let _ = runtime_registry
                .send_user_message(&provider_clone, &cid, &payload)
                .await;
        });
    }

    (
        StatusCode::OK,
        Json(json!({"conversationId": conversation_id})),
    )
        .into_response()
}
