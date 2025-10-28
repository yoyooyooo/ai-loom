use crate::services::codex::app_server::get_or_start;
use crate::state::AppState;
use crate::ws::chat_events::{event, ChatError, ChatEvent};
use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct SendBody {
    pub text: String,
}

pub async fn send_message(
    Path(conversation_id): Path<String>,
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<SendBody>,
) -> impl IntoResponse {
    let text = body.text.trim().to_string();
    if text.is_empty() {
        return (StatusCode::BAD_REQUEST, "消息不能为空").into_response();
    }
    let client = match get_or_start(Some(state.workspace_root.clone())).await {
        Ok(c) => c,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("Codex 未就绪：{}", e)).into_response(),
    };
    if let Some(hub) = state.ws_hub.clone() {
        client.register_ws_hub(hub);
    }
    let app = client.app();
    // 确保已监听该会话的事件（即使会话不是由本服务 new/resume 创建）
    let _ = app.ensure_listener(&conversation_id).await;
    tracing::info!(target:"codex", conversationId=%conversation_id, len=text.len(), preview=%text.chars().take(40).collect::<String>(), "HTTP send → sendUserMessage");
    let _ = app
        .send_user_message(conversation_id.clone(), text)
        .await
        .map_err(|e| {
            if let Some(hub) = state.ws_hub.clone() {
                let (m, p) = event(ChatEvent::MessageFailed {
                    error: ChatError {
                        message: format!("{}", e),
                    },
                });
                hub.broadcast(m, p);
            }
        })
        .ok();
    (StatusCode::ACCEPTED, "accepted").into_response()
}
