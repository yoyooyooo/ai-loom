use crate::services::codex::app_server::get_or_start;
use crate::state::AppState;
use axum::{extract::Path, extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
pub struct InterruptQuery {
    #[serde(rename = "await")]
    pub await_param: Option<String>,
}

pub async fn interrupt_conversation(
    Path(conversation_id): Path<String>,
    Query(query): Query<InterruptQuery>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
    let client = match get_or_start(Some(state.workspace_root.clone())).await {
        Ok(c) => c,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("Codex 未就绪：{}", e)).into_response(),
    };
    let app = client.app();
    tracing::info!(target:"codex", conversationId=%conversation_id, "HTTP interrupt → interruptConversation");
    let await_turn_aborted = match query.await_param.as_deref() {
        Some("turnAborted") | Some("1") | Some("true") => true,
        _ => false,
    };

    if await_turn_aborted {
        match app.interrupt_conversation(conversation_id).await {
            Ok(resp) => {
                // 返回中止原因，便于前端确认
                return (StatusCode::OK, Json(serde_json::json!({
                    "abortReason": resp.abort_reason,
                })))
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    format!("interruptConversation 等待失败：{}", e),
                )
                    .into_response();
            }
        }
    } else {
        let _ = app.interrupt_conversation(conversation_id).await;
        (StatusCode::OK, "ok").into_response()
    }
}
