use crate::services::codex::app_server::get_or_start;
use crate::services::codex::bridge::store_conversation_id;
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
}

pub async fn new_conversation(
    axum::extract::State(state): axum::extract::State<AppState>,
    body: Option<Json<NewConversationRequest>>,
) -> impl IntoResponse {
    // Ensure Codex client is running
    let cwd = Some(state.workspace_root.clone());
    let client_res = get_or_start(cwd).await;
    let client = match client_res {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("启动 Codex 失败：{}", e)).into_response()
        }
    };
    if let Some(hub) = state.ws_hub.clone() {
        client.register_ws_hub(hub);
    }

    // newConversation → addConversationListener
    // 传入 cwd 与 sandbox 以贴近官方最小样例
    let app = client.app();
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

    let resp_v = app.new_conversation(params).await;
    let result = match resp_v {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(target:"codex", error=%e, "newConversation 调用失败");
            return (
                StatusCode::BAD_GATEWAY,
                format!("newConversation 调用失败：{}", e),
            )
                .into_response();
        }
    };
    let conversation_id = result.conversation_id.to_string();
    tracing::info!(target:"codex", conversationId=%conversation_id, "HTTP /api/chat/conversations → OK");
    let _ = app.add_conversation_listener(conversation_id.clone()).await;
    store_conversation_id(&conversation_id);
    // Broadcast session.new for UI to bind
    if let Some(hub) = state.ws_hub.clone() {
        let (m, p) = event(ChatEvent::SessionNew {
            conversation_id: conversation_id.clone(),
        });
        hub.broadcast(m, p);
    }
    (
        StatusCode::OK,
        Json(json!({"conversationId": conversation_id})),
    )
        .into_response()
}
