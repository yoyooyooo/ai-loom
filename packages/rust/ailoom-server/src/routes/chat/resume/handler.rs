use std::path::PathBuf;

use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use codex_app_server_protocol::{
    ListConversationsParams, NewConversationParams, ResumeConversationParams,
};

use crate::routes::chat::utils::conversation_path_of;
use crate::services::codex::app_server::get_or_start;
use crate::state::AppState;
use crate::ws::chat_events::{ChatEvent, ChatHistoryEntry};

use super::config::build_resume_config;
use super::event_accumulator::EventAccumulator;
use super::history::convert_history_item;
use super::io::lookup_path_by_conversation_id;
use super::rollout_parser::load_rollout_snapshot;
use super::service::broadcast_resume;
use super::types::{ResumeBody, ResumeConfigResponse, ResumeQuery};

fn is_per_conv_mode() -> bool {
    std::env::var("AILOOM_CODEX_MODE")
        .ok()
        .map(|v| v == "per_conv")
        .unwrap_or(true)
}

async fn resume_from_path(
    app: &crate::services::codex::client::AppServerClient,
    state: &AppState,
    path: &str,
) -> Result<
    (
        String,
        Vec<ChatHistoryEntry>,
        Vec<(ChatEvent, Option<usize>)>,
        Option<ResumeConfigResponse>,
        Option<String>,
    ),
    (StatusCode, String),
> {
    let default_cwd = state.workspace_root.to_string_lossy().to_string();
    let (
        override_params,
        resume_config,
        fallback_history,
        mut fallback_events,
        base_ts,
        cid_from_snapshot,
    ) = match load_rollout_snapshot(path).await {
        Some(parsed) => {
            let parsed = parsed;
            let (overrides, config_response) = build_resume_config(&parsed.snapshot);
            // 基于文件 mtime 生成一个稳定起始时间（精度有限，用于恢复场景估算）
            let base_ts = std::fs::metadata(path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|st| {
                    let dt: time::OffsetDateTime = st.into();
                    dt.format(&time::format_description::well_known::Rfc3339)
                        .ok()
                });
            let overrides_cwd = overrides.cwd.clone();
            let mut params = NewConversationParams {
                cwd: Some(default_cwd.clone()),
                ..Default::default()
            };
            if let Some(cwd_path) = overrides_cwd {
                params.cwd = Some(cwd_path.to_string_lossy().to_string());
            }
            params.model = overrides.model;
            params.approval_policy = overrides.approval_policy;
            params.sandbox = overrides.sandbox_mode;
            if !overrides.config_map.is_empty() {
                params.config = Some(overrides.config_map);
            }
            let cid_guess = parsed
                .snapshot
                .session_meta
                .as_ref()
                .map(|sm| sm.meta.id.to_string());
            (
                params,
                Some(config_response),
                parsed.history,
                parsed.events,
                base_ts,
                cid_guess,
            )
        }
        None => (
            NewConversationParams {
                cwd: Some(default_cwd.clone()),
                ..Default::default()
            },
            None,
            Vec::new(),
            Vec::new(),
            None,
            None,
        ),
    };

    // per-conv：优先离线恢复（不触发全局 app-server 的 resumeConversation，避免额外 sessionConfigured）
    let (conversation_id, initial_messages) = if is_per_conv_mode() {
        if let Some(cid) = cid_from_snapshot.clone() {
            (cid, Vec::new())
        } else {
            // 非常态：无法从快照拿到会话 id，只能回退到在线 resume
            let resp = app
                .resume_conversation(ResumeConversationParams {
                    path: Some(PathBuf::from(path)),
                    conversation_id: None,
                    history: None,
                    overrides: Some(override_params.clone()),
                })
                .await
                .map_err(|e| {
                    tracing::warn!(target:"codex", error=%e, "resumeConversation 调用失败");
                    (
                        StatusCode::BAD_GATEWAY,
                        format!("resumeConversation 调用失败：{}", e),
                    )
                })?;
            (
                resp.conversation_id.to_string(),
                resp.initial_messages.unwrap_or_default(),
            )
        }
    } else {
        let resp = app
            .resume_conversation(ResumeConversationParams {
                path: Some(PathBuf::from(path)),
                conversation_id: None,
                history: None,
                overrides: Some(override_params),
            })
            .await
            .map_err(|e| {
                tracing::warn!(target:"codex", error=%e, "resumeConversation 调用失败");
                (
                    StatusCode::BAD_GATEWAY,
                    format!("resumeConversation 调用失败：{}", e),
                )
            })?;
        (
            resp.conversation_id.to_string(),
            resp.initial_messages.unwrap_or_default(),
        )
    };

    // 优先采用 rollout.jsonl 解析得到的完整历史（fallback_history）；
    // Codex 的 initial_messages 可能仅包含“启动/提示性”的首条助手消息，
    // 若直接使用会导致快照缺失后续助手消息或推理文本。
    let mut history_messages: Vec<ChatHistoryEntry> = if !fallback_history.is_empty() {
        fallback_history
    } else {
        initial_messages
            .iter()
            .filter_map(|event| serde_json::to_value(event).ok())
            .filter_map(|value| convert_history_item(&value))
            .collect()
    };

    let mut resume_events: Vec<(ChatEvent, Option<usize>)> = Vec::new();
    if !fallback_events.is_empty() {
        resume_events.extend(fallback_events.drain(..));
    }

    // 若已从 rollout.jsonl 获得 history/events，则忽略 Codex 的 initial_messages 衍生事件，
    // 以免较早的 MessageCompleted 覆盖更完整的历史助手文本。
    let has_fallback_baseline = !history_messages.is_empty() || !resume_events.is_empty();
    if !has_fallback_baseline && !initial_messages.is_empty() {
        let mut accumulator = EventAccumulator::default();
        for item in &initial_messages {
            if let Ok(value) = serde_json::to_value(item) {
                accumulator.handle_value(&value);
            }
        }
        let initial_events = accumulator.finish();
        if !initial_events.is_empty() {
            resume_events.extend(initial_events);
        }
    }

    // 在 per-conv 模式下，不在“HTTP resume”路径上对全局实例建立监听，避免与会话专属子进程产生“双监听”。
    // 转由 registry::ensure_listener 为该会话拉起/确保子进程监听。
    if is_per_conv_mode() {
        let _ = crate::services::codex::registry::ensure_listener(
            state.workspace_root.clone(),
            state.ws_hub.clone(),
            &conversation_id,
        )
        .await;
    } else {
        let _ = app.ensure_listener(&conversation_id).await;
    }
    Ok((
        conversation_id,
        history_messages,
        resume_events,
        resume_config,
        base_ts,
    ))
}

pub async fn resume_conversation(
    Query(_query): Query<ResumeQuery>,
    axum::extract::State(state): axum::extract::State<AppState>,
    maybe_body: Option<Json<ResumeBody>>,
) -> impl IntoResponse {
    let body = maybe_body.map(|b| b.0).unwrap_or_default();

    if let Some(path) = body.path.as_ref() {
        tracing::info!(target:"codex", path=%path, "HTTP resume → resumeConversation(explicit)");
        // 仅在需要在线 resume 时再懒加载全局 client
        let client = match get_or_start(Some(state.workspace_root.clone())).await {
            Ok(c) => c,
            Err(e) => {
                return (StatusCode::BAD_GATEWAY, format!("Codex 未就绪：{}", e)).into_response()
            }
        };
        if let Some(hub) = state.ws_hub.clone() {
            client.register_ws_hub(hub);
        }
        let app = client.app();
        return match resume_from_path(&app, &state, path).await {
            Ok((conversation_id, history, events, config, _base_ts)) => {
                // 尝试判断该 rollout 是否仍在进行中（CLI 驱动场景提示用）
                let in_progress = super::rollout_parser::rollout_in_progress(path).or(Some(false));
                broadcast_resume(&state, &conversation_id, &history);
                // 组装 turns（快照）
                let mut turns = super::service::build_turns_from_history_and_events(
                    &conversation_id,
                    &history,
                    &events,
                );
                super::service::shrink_turns_and_emit_blobs(&state, &conversation_id, &mut turns);
                // 计算 uptoEventId 用于前端推进游标（不再通过 events 返回）
                let upto_event_id = if let Some(hub) = state.ws_hub.clone() {
                    let tail = hub.tail_chat(Some(&conversation_id), None, 1);
                    tail.into_iter().map(|e| e.id).max()
                } else {
                    None
                };
                (
                    StatusCode::OK,
                    Json(super::types::ResumeResponsePayload {
                        conversation_id,
                        history: Vec::new(),
                        events: Vec::new(),
                        turns,
                        config,
                        in_progress,
                        upto_event_id,
                        turns_schema_version: 1,
                    }),
                )
                    .into_response()
            }
            Err((status, msg)) => (status, msg).into_response(),
        };
    }

    if let Some(conversation_id) = body.conversation_id.as_ref() {
        tracing::info!(
            target:"codex",
            conversationId=%conversation_id,
            "HTTP resume → resumeConversation(by id)"
        );
        // per-conv：如果该会话已由本服务托管（有子进程），则避免任何在线 resume，直接确保监听并返回最小快照
        if is_per_conv_mode() && crate::services::codex::registry::has_child(conversation_id).await
        {
            let _ = crate::services::codex::registry::ensure_listener(
                state.workspace_root.clone(),
                state.ws_hub.clone(),
                conversation_id,
            )
            .await;
            // 计算 uptoEventId，按 SSoT 走 WS 恢复
            let upto_event_id = if let Some(hub) = state.ws_hub.clone() {
                let tail = hub.tail_chat(Some(conversation_id), None, 1);
                tail.into_iter().map(|e| e.id).max()
            } else {
                None
            };
            return (
                StatusCode::OK,
                Json(super::types::ResumeResponsePayload {
                    conversation_id: conversation_id.clone(),
                    history: Vec::new(),
                    events: Vec::new(),
                    turns: Vec::new(),
                    config: None,
                    in_progress: None,
                    upto_event_id,
                    turns_schema_version: 1,
                }),
            )
                .into_response();
        }
        // per-conv：如已托管，直接确保监听并返回最小快照（不在线 resume）
        if is_per_conv_mode() && crate::services::codex::registry::has_child(conversation_id).await
        {
            let _ = crate::services::codex::registry::ensure_listener(
                state.workspace_root.clone(),
                state.ws_hub.clone(),
                conversation_id,
            )
            .await;
            let upto_event_id = if let Some(hub) = state.ws_hub.clone() {
                hub.tail_chat(Some(conversation_id), None, 1)
                    .into_iter()
                    .map(|e| e.id)
                    .max()
            } else {
                None
            };
            return (
                StatusCode::OK,
                Json(super::types::ResumeResponsePayload {
                    conversation_id: conversation_id.clone(),
                    history: Vec::new(),
                    events: Vec::new(),
                    turns: Vec::new(),
                    config: None,
                    in_progress: None,
                    upto_event_id,
                    turns_schema_version: 1,
                }),
            )
                .into_response();
        }
        // 需要在线能力时再懒加载 client
        let client = match get_or_start(Some(state.workspace_root.clone())).await {
            Ok(c) => c,
            Err(e) => {
                return (StatusCode::BAD_GATEWAY, format!("Codex 未就绪：{}", e)).into_response()
            }
        };
        if let Some(hub) = state.ws_hub.clone() {
            client.register_ws_hub(hub);
        }
        let app = client.app();
        if let Some(path) = lookup_path_by_conversation_id(&app, conversation_id).await {
            return match resume_from_path(&app, &state, &path).await {
                Ok((conversation_id, history, events, config, _base_ts)) => {
                    let in_progress =
                        super::rollout_parser::rollout_in_progress(&path).or(Some(false));
                    broadcast_resume(&state, &conversation_id, &history);
                    let mut turns = super::service::build_turns_from_history_and_events(
                        &conversation_id,
                        &history,
                        &events,
                    );
                    super::service::shrink_turns_and_emit_blobs(
                        &state,
                        &conversation_id,
                        &mut turns,
                    );
                    let upto_event_id = if let Some(hub) = state.ws_hub.clone() {
                        let tail = hub.tail_chat(Some(&conversation_id), None, 1);
                        tail.into_iter().map(|e| e.id).max()
                    } else {
                        None
                    };
                    (
                        StatusCode::OK,
                        Json(super::types::ResumeResponsePayload {
                            conversation_id,
                            history: Vec::new(),
                            events: Vec::new(),
                            turns,
                            config,
                            in_progress,
                            upto_event_id,
                            turns_schema_version: 1,
                        }),
                    )
                        .into_response()
                }
                Err((status, msg)) => (status, msg).into_response(),
            };
        } else {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": {
                        "message": format!("会话 {} 不存在或未找到对应路径", conversation_id)
                    }
                })),
            )
                .into_response();
        }
    }

    // 懒加载 client 仅在 latest 分支需要
    let client = match get_or_start(Some(state.workspace_root.clone())).await {
        Ok(c) => c,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("Codex 未就绪：{}", e)).into_response(),
    };
    if let Some(hub) = state.ws_hub.clone() {
        client.register_ws_hub(hub);
    }
    let app = client.app();
    if let Ok(list) = app
        .list_conversations(ListConversationsParams {
            page_size: Some(1),
            cursor: None,
            ..Default::default()
        })
        .await
    {
        if let Some(first) = list.items.first() {
            if let Ok(first_value) = serde_json::to_value(first) {
                if let Some(path) = conversation_path_of(&first_value) {
                    tracing::info!(target:"codex", path=%path, "HTTP resume → resumeConversation(latest)");
                    return match resume_from_path(&app, &state, &path).await {
                        Ok((conversation_id, history, events, config, _base_ts)) => {
                            let in_progress =
                                super::rollout_parser::rollout_in_progress(&path).or(Some(false));
                            broadcast_resume(&state, &conversation_id, &history);
                            let mut turns = super::service::build_turns_from_history_and_events(
                                &conversation_id,
                                &history,
                                &events,
                            );
                            super::service::shrink_turns_and_emit_blobs(
                                &state,
                                &conversation_id,
                                &mut turns,
                            );
                            let upto_event_id = if let Some(hub) = state.ws_hub.clone() {
                                let tail = hub.tail_chat(Some(&conversation_id), None, 1);
                                tail.into_iter().map(|e| e.id).max()
                            } else {
                                None
                            };
                            (
                                StatusCode::OK,
                                Json(super::types::ResumeResponsePayload {
                                    conversation_id,
                                    history: Vec::new(),
                                    events: Vec::new(),
                                    turns,
                                    config,
                                    in_progress,
                                    upto_event_id,
                                    turns_schema_version: 1,
                                }),
                            )
                                .into_response()
                        }
                        Err((status, msg)) => (status, msg).into_response(),
                    };
                }
            }
        }
    }

    (StatusCode::NOT_FOUND, "未找到可恢复会话").into_response()
}
