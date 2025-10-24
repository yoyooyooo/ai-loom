use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use codex_app_server_protocol::ListConversationsParams;
use serde_json::json;

use crate::{
    routes::chat::utils::{
        codex_not_reachable_hint, conversation_id_of, map_error_to_status,
        normalize_conversation_item,
    },
    services::codex::app_server::get_or_start,
    state::AppState,
};

pub async fn get_conversation(
    Path(conversation_id): Path<String>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
    let client = match get_or_start(Some(state.workspace_root.clone())).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(target:"codex", error=%e, "Codex 未就绪");
            return (
                StatusCode::BAD_GATEWAY,
                format!("Codex 未就绪：{}。{}", e, codex_not_reachable_hint()),
            )
                .into_response();
        }
    };

    let app = client.app();
    let mut cursor: Option<String> = None;

    loop {
        let resp = match app
            .list_conversations(ListConversationsParams {
                page_size: Some(50),
                cursor: cursor.clone(),
            })
            .await
        {
            Ok(v) => v,
            Err(e) => {
                let status = map_error_to_status(&e.to_string());
                tracing::warn!(target:"codex", error=%e, "listConversations 调用失败");
                return (status, format!("listConversations 失败：{}", e)).into_response();
            }
        };

        for item in &resp.items {
            if let Ok(item_value) = serde_json::to_value(item) {
                if let Some(id) = conversation_id_of(&item_value) {
                    if id == conversation_id {
                        return (
                            StatusCode::OK,
                            Json(json!({"conversation": normalize_conversation_item(&item_value)})),
                        )
                            .into_response();
                    }
                }
            }
        }

        cursor = resp.next_cursor.clone();
        if cursor.is_none() {
            break;
        }
    }

    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": {
                "message": format!("会话 {} 不存在或已被清理", conversation_id)
            }
        })),
    )
        .into_response()
}
