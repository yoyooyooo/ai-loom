use crate::services::codex::app_server::get_or_start;
use crate::state::AppState;
use axum::{extract::Path, http::StatusCode, response::IntoResponse};

pub async fn interrupt_conversation(
    Path(conversation_id): Path<String>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
    let client = match get_or_start(Some(state.workspace_root.clone())).await {
        Ok(c) => c,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("Codex 未就绪：{}", e)).into_response(),
    };
    let app = client.app();
    tracing::info!(target:"codex", conversationId=%conversation_id, "HTTP interrupt → interruptConversation");
    let _ = app.interrupt_conversation(conversation_id).await;
    (StatusCode::OK, "ok").into_response()
}
