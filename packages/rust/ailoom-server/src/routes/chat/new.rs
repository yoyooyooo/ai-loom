use crate::services::codex::bridge::store_conversation_id;
use crate::services::codex::registry;
use crate::state::AppState;
use crate::ws::chat_events::{event, ChatEvent};
use axum::{http::StatusCode, response::IntoResponse, Json};
use codex_app_server_protocol::NewConversationParams;
use codex_protocol::{config_types::SandboxMode, protocol::AskForApproval};
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewConversationRequest {
    pub model: Option<String>,
    pub approval_policy: Option<AskForApproval>,
    pub sandbox_mode: Option<SandboxMode>,
    /// 可选：首条用户消息。提供该字段时，将在创建会话后立即发送，避免“只建不跑”。
    pub text: Option<String>,
}

pub async fn new_conversation(
    axum::extract::State(state): axum::extract::State<AppState>,
    body: Option<Json<NewConversationRequest>>,
) -> impl IntoResponse {
    // 每会话子进程：spawn_new → newConversation → ensure_listener
    let req = body.map(|Json(inner)| inner).unwrap_or_default();
    let mut params = NewConversationParams {
        cwd: Some(state.workspace_root.to_string_lossy().to_string()),
        ..Default::default()
    };
    if let Some(model) = req.model {
        params.model = Some(model);
    }
    if let Some(policy) = req.approval_policy {
        params.approval_policy = Some(policy);
    }
    if let Some(sandbox) = req.sandbox_mode {
        params.sandbox = Some(sandbox);
    }

    let conversation_id =
        match registry::spawn_new(state.workspace_root.clone(), state.ws_hub.clone(), params).await
        {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!(target:"codex", error=%e, "spawn_new 失败");
                return (
                    StatusCode::BAD_GATEWAY,
                    format!("启动 Codex 会话失败：{}", e),
                )
                    .into_response();
            }
        };
    tracing::info!(target:"codex", conversationId=%conversation_id, "HTTP /api/chat/conversations → OK");
    store_conversation_id(&conversation_id);
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
        let ws_root = state.workspace_root.clone();
        let ws_hub = state.ws_hub.clone();
        let cid = conversation_id.clone();
        let payload = text.clone();
        tokio::spawn(async move {
            let _ = registry::send_user_message(ws_root, ws_hub, &cid, payload).await;
        });
    }

    (
        StatusCode::OK,
        Json(json!({"conversationId": conversation_id})),
    )
        .into_response()
}
