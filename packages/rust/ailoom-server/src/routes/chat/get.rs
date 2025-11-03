use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use codex_app_server_protocol::ListConversationsParams;
use serde_json::{json, Value};

use crate::{
    routes::chat::utils::{
        codex_not_reachable_hint, conversation_id_of, map_error_to_status,
        normalize_conversation_item, resolve_rollout_path,
    },
    state::AppState,
};
use ailoom_executors::providers::codex::{get_or_start, load_rollout_summary, RolloutSummary};

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
                                if let Ok(summary) = load_rollout_summary(&abs).await {
                                    let RolloutSummary {
                                        preview,
                                        depth,
                                        parent_id,
                                        root_id,
                                        in_progress,
                                    } = summary;
                                    if let Some(obj) = normalized.as_object_mut() {
                                        if let Some(preview) = preview {
                                            obj.insert("preview".into(), Value::String(preview));
                                        }
                                        if obj.get("depth").and_then(|d| d.as_i64()).is_none() {
                                            if let Some(depth) = depth {
                                                obj.insert("depth".into(), Value::from(depth));
                                            }
                                        }
                                        if obj.get("parentId").and_then(|d| d.as_str()).is_none() {
                                            if let Some(pid) = parent_id {
                                                let self_id = obj
                                                    .get("conversationId")
                                                    .and_then(|x| x.as_str())
                                                    .map(|s| s.to_string())
                                                    .unwrap_or_default();
                                                if self_id.is_empty() || self_id != pid {
                                                    obj.insert(
                                                        "parentId".into(),
                                                        Value::String(pid),
                                                    );
                                                }
                                            }
                                        }
                                        if obj.get("rootId").and_then(|d| d.as_str()).is_none() {
                                            if let Some(root_id) = root_id {
                                                obj.insert("rootId".into(), Value::String(root_id));
                                            }
                                        }
                                        if obj.get("inProgress").and_then(|b| b.as_bool()).is_none()
                                        {
                                            if let Some(in_prog) = in_progress {
                                                obj.insert(
                                                    "inProgress".into(),
                                                    Value::Bool(in_prog),
                                                );
                                            }
                                        }
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
