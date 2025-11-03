use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::PathBuf;
use tokio::task::JoinSet;

use crate::{
    routes::chat::utils::{normalize_conversation_item, resolve_rollout_path},
    state::AppState,
};
use ailoom_executors::providers::codex::{
    current, list_offline_conversations, load_rollout_summary, RolloutSummary,
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
    let page_size = params.page_size.unwrap_or(20).clamp(1, 50);

    let mut raw_items: Vec<Value>;
    let mut next_cursor: Option<String> = None;
    let mut codex_unavailable = false;

    if let Some(client) = current().await {
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
        next_cursor = response.next_cursor.clone();
        raw_items = response
            .items
            .into_iter()
            .map(|item| serde_json::to_value(item).unwrap_or(Value::Null))
            .collect();
    } else {
        codex_unavailable = true;
        match list_offline_conversations(page_size, params.cursor.as_deref()).await {
            Ok(page) => {
                next_cursor = page.next_cursor;
                raw_items = page.items;
            }
            Err(err) => {
                tracing::warn!(
                    target:"codex",
                    error=%err,
                    "离线扫描会话失败，返回空列表"
                );
                raw_items = Vec::new();
                next_cursor = None;
            }
        }
    };

    let mut mapped: Vec<Value> = raw_items
        .iter()
        .map(|item| normalize_conversation_item(item))
        .collect();

    // 批量加载 rollout summary（preview/lineage/in-progress）
    let mut rollout_fallbacks: HashSet<(String, String, bool)> = HashSet::new();

    struct SummaryJob {
        index: usize,
        conversation_id: Option<String>,
        provider_id: String,
        path: PathBuf,
    }

    let mut summary_jobs: Vec<SummaryJob> = Vec::new();

    for (index, v) in mapped.iter_mut().enumerate() {
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
        let provider_id = v
            .get("providerId")
            .and_then(|p| p.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "codex".into());
        if v.get("providerId").is_none() {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("providerId".into(), Value::String(provider_id.clone()));
            }
        }

        // 内存聚合优先：若 Hub 已有该会话的 inProgress 标记，直接使用
        if v.get("inProgress").and_then(|b| b.as_bool()).is_none() {
            if let (Some(hub), Some(conversation_id)) = (state.ws_hub.clone(), cid.as_deref()) {
                if let Some(in_mem) = hub.get_in_progress(conversation_id) {
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("inProgress".into(), Value::from(in_mem));
                    }
                }
            }
        }

        if let Some(abs) = resolve_rollout_path(path_str, &state.workspace_root) {
            summary_jobs.push(SummaryJob {
                index,
                conversation_id: cid.clone(),
                provider_id: provider_id.clone(),
                path: abs,
            });
        }
    }

    if !summary_jobs.is_empty() {
        let mut invalid_indices: Vec<usize> = Vec::new();
        let mut join_set: JoinSet<(
            usize,
            Option<String>,
            String,
            std::io::Result<RolloutSummary>,
        )> = JoinSet::new();
        for job in summary_jobs {
            join_set.spawn(async move {
                let summary = load_rollout_summary(&job.path).await;
                (job.index, job.conversation_id, job.provider_id, summary)
            });
        }

        while let Some(result) = join_set.join_next().await {
            match result {
                Ok((index, conversation_id, provider_id, Ok(summary))) => {
                    if let Some(value) = mapped.get_mut(index) {
                        if let Some(obj) = value.as_object_mut() {
                            let RolloutSummary {
                                preview,
                                depth,
                                parent_id,
                                root_id,
                                in_progress,
                            } = summary;

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
                                    // 避免自环（若 pid 与自身相同则跳过）
                                    let self_id = obj
                                        .get("conversationId")
                                        .and_then(|x| x.as_str())
                                        .map(|s| s.to_string())
                                        .unwrap_or_default();
                                    if self_id.is_empty() || self_id != pid {
                                        obj.insert("parentId".into(), Value::String(pid));
                                    }
                                }
                            }

                            if obj.get("rootId").and_then(|d| d.as_str()).is_none() {
                                if let Some(root_id) = root_id {
                                    obj.insert("rootId".into(), Value::String(root_id));
                                }
                            }

                            if obj.get("inProgress").and_then(|b| b.as_bool()).is_none() {
                                if let Some(in_prog) = in_progress {
                                    obj.insert("inProgress".into(), Value::from(in_prog));
                                    if let Some(conv_id) = conversation_id.as_ref() {
                                        rollout_fallbacks.insert((
                                            conv_id.clone(),
                                            provider_id.clone(),
                                            in_prog,
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
                Ok((index, _conversation_id, _provider_id, Err(err))) => {
                    tracing::debug!(
                        target:"codex",
                        error=%err,
                        index=%index,
                        "rollout summary 解析失败"
                    );
                    if err.kind() == ErrorKind::NotFound {
                        invalid_indices.push(index);
                    }
                }
                Err(join_err) => {
                    tracing::warn!(
                        target:"codex",
                        error=%join_err,
                        "rollout summary join 失败"
                    );
                }
            }
        }

        if !invalid_indices.is_empty() {
            invalid_indices.sort_unstable();
            invalid_indices.dedup();
            for idx in invalid_indices.into_iter().rev() {
                if idx < mapped.len() {
                    mapped.remove(idx);
                }
            }
        }
    }

    if !rollout_fallbacks.is_empty() {
        if let Some(hub) = state.ws_hub.clone() {
            for (conversation_id, provider_id, generating) in rollout_fallbacks.into_iter() {
                broadcast_generating_from_rollout(&hub, &conversation_id, &provider_id, generating);
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

    (
        StatusCode::OK,
        Json(json!({
          "items": mapped,
          "nextCursor": next_cursor,
          "codexUnavailable": codex_unavailable
        })),
    )
        .into_response()
}

pub(crate) fn broadcast_generating_from_rollout(
    hub: &crate::ws::hub::Hub,
    conversation_id: &str,
    provider_id: &str,
    generating: bool,
) {
    if hub.get_in_progress(conversation_id) == Some(generating) {
        return;
    }
    let mut payload = Map::new();
    payload.insert(
        "conversationId".into(),
        Value::String(conversation_id.to_string()),
    );
    if !provider_id.is_empty() {
        payload.insert("provider".into(), Value::String(provider_id.to_string()));
        payload.insert("providerId".into(), Value::String(provider_id.to_string()));
    }
    payload.insert("generating".into(), Value::Bool(generating));
    payload.insert("source".into(), Value::String("rollout_fallback".into()));
    hub.broadcast(
        "chat.info.runtime.generating".into(),
        Value::Object(payload),
    );
}

#[cfg(test)]
mod tests {
    use super::broadcast_generating_from_rollout;
    use crate::ws::hub::Hub;

    #[test]
    fn broadcast_generating_marks_progress() {
        let hub = Hub::new(16);
        assert_eq!(hub.get_in_progress("conv-1"), None);
        broadcast_generating_from_rollout(&hub, "conv-1", "codex", true);
        assert_eq!(hub.get_in_progress("conv-1"), Some(true));

        let events = hub.tail_chat(Some("conv-1"), None, 10);
        assert_eq!(events.len(), 1);

        broadcast_generating_from_rollout(&hub, "conv-1", "codex", false);
        assert_eq!(hub.get_in_progress("conv-1"), Some(false));

        let events_after = hub.tail_chat(Some("conv-1"), None, 10);
        assert_eq!(events_after.len(), 2);
    }
}
