use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use codex_app_server_protocol::ListConversationsParams;
use serde_json::{json, Value};

use crate::{
    routes::chat::utils::{
        codex_not_reachable_hint, conversation_id_of, derive_first_user_message_from_rollout,
        map_error_to_status, normalize_conversation_item, resolve_rollout_path,
    },
    state::AppState,
};
use ailoom_executors::providers::codex::get_or_start;

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
                ..Default::default()
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
                        let mut normalized = normalize_conversation_item(&item_value);
                        if let Some(path_str) = normalized
                            .get("path")
                            .and_then(|p| p.as_str())
                            .filter(|p| !p.is_empty())
                        {
                            if let Some(abs) = resolve_rollout_path(path_str, &state.workspace_root)
                            {
                                if let Some(first_user) =
                                    derive_first_user_message_from_rollout(&abs)
                                {
                                    if let Some(obj) = normalized.as_object_mut() {
                                        obj.insert("preview".into(), Value::String(first_user));
                                    }
                                }
                            }
                        }
                        return (StatusCode::OK, Json(json!({"conversation": normalized})))
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
