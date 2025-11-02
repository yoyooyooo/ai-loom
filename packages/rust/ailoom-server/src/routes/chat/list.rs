use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    routes::chat::resume::rollout_in_progress,
    routes::chat::utils::{
        derive_first_user_message_from_rollout, derive_lineage_from_rollout,
        derive_turns_from_rollout, normalize_conversation_item, resolve_rollout_path,
    },
    services::codex::app_server::get_or_start,
    state::AppState,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    #[serde(default)]
    pub page_size: Option<usize>,
    #[serde(default)]
    pub cursor: Option<String>,
}

pub async fn list_conversations(
    Query(params): Query<ListQuery>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
    let client = match get_or_start(Some(state.workspace_root.clone())).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(target:"codex", error=%e, "get_or_start 失败，返回空列表");
            return (
                StatusCode::OK,
                Json(
                    json!({ "items": [], "nextCursor": Value::Null, "error": "codex_unavailable" }),
                ),
            )
                .into_response();
        }
    };

    let page_size = params.page_size.unwrap_or(20).clamp(1, 50);

    let app = client.app();
    let response = match app
        .list_conversations(codex_app_server_protocol::ListConversationsParams {
            page_size: Some(page_size),
            cursor: params.cursor.filter(|c| !c.is_empty()),
            ..Default::default()
        })
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(target:"codex", error=%e, "listConversations 调用失败，返回空列表");
            return (
                StatusCode::OK,
                Json(json!({ "items": [], "nextCursor": Value::Null })),
            )
                .into_response();
        }
    };

    let items = response
        .items
        .into_iter()
        .map(|item| serde_json::to_value(item).unwrap_or(Value::Null))
        .collect::<Vec<_>>();

    let mut mapped: Vec<Value> = items
        .iter()
        .map(|item| normalize_conversation_item(item))
        .collect();

    // 若缺少 lineage 字段，则尝试根据 rollout JSONL 顶部的 session_meta 推导
    for v in mapped.iter_mut() {
        let need_depth = v.get("depth").and_then(|d| d.as_i64()).is_none();
        let need_parent = v.get("parentId").and_then(|d| d.as_str()).is_none();
        let need_root = v.get("rootId").and_then(|d| d.as_str()).is_none();
        let cid = v
            .get("conversationId")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let path_str_opt = v
            .get("path")
            .and_then(|p| p.as_str())
            .map(|s| s.to_string());
        let Some(path_str) = path_str_opt.as_deref() else {
            continue;
        };
        // 内存聚合优先：若 Hub 已有该会话的 inProgress 标记，直接使用
        if let (Some(hub), Some(conversation_id)) = (state.ws_hub.clone(), cid.as_deref()) {
            if let Some(in_mem) = hub.get_in_progress(conversation_id) {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("inProgress".into(), Value::from(in_mem));
                }
            }
        }
        if let Some(abs) = resolve_rollout_path(path_str, &state.workspace_root) {
            if let Some(first_user) = derive_first_user_message_from_rollout(&abs) {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("preview".into(), Value::String(first_user));
                }
            }
            // lineage 推导
            if need_depth || need_parent || need_root {
                if let Some((d, parent, root)) = derive_lineage_from_rollout(&abs) {
                    if let Some(obj) = v.as_object_mut() {
                        if need_depth {
                            obj.insert("depth".into(), Value::from(d));
                        }
                        if need_parent {
                            if let Some(pid) = parent {
                                // 避免自环（若 pid 与自身相同则跳过）
                                let self_id = obj
                                    .get("conversationId")
                                    .and_then(|x| x.as_str())
                                    .map(|s| s.to_string())
                                    .unwrap_or_default();
                                if !self_id.is_empty() && self_id != pid {
                                    obj.insert("parentId".into(), Value::String(pid));
                                }
                            }
                        }
                        if need_root {
                            if let Some(rid) = root {
                                obj.insert("rootId".into(), Value::String(rid));
                            }
                        }
                    }
                }
            }
            // turns 推导
            if let Some(turns) = derive_turns_from_rollout(&abs) {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("turns".into(), Value::from(turns));
                }
            }
            // 回退：若内存聚合缺失，使用 rollout 扫描推导 inProgress（用于刷新/重启后的回显）
            let need_in_progress = v.get("inProgress").and_then(|b| b.as_bool()).is_none();
            if need_in_progress {
                if let Some(in_prog) = rollout_in_progress(&abs.to_string_lossy()) {
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("inProgress".into(), Value::from(in_prog));
                    }
                }
            }
        }
    }

    mapped.sort_by(|a, b| {
        let at = a
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let bt = b
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        bt.cmp(at)
    });

    let next_cursor = response.next_cursor.clone();

    (
        StatusCode::OK,
        Json(json!({
          "items": mapped,
          "nextCursor": next_cursor
        })),
    )
        .into_response()
}
