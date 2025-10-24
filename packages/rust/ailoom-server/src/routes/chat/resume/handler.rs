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
use super::service::{broadcast_resume, into_resume_event_payload};
use super::types::{ResumeBody, ResumeConfigResponse, ResumeQuery};

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
    ),
    (StatusCode, String),
> {
    let default_cwd = state.workspace_root.to_string_lossy().to_string();
    let (override_params, resume_config, fallback_history, mut fallback_events) =
        match load_rollout_snapshot(path).await {
            Some(parsed) => {
                let parsed = parsed;
                let (overrides, config_response) = build_resume_config(&parsed.snapshot);
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
                (params, Some(config_response), parsed.history, parsed.events)
            }
            None => (
                NewConversationParams {
                    cwd: Some(default_cwd.clone()),
                    ..Default::default()
                },
                None,
                Vec::new(),
                Vec::new(),
            ),
        };

    let resp = app
        .resume_conversation(ResumeConversationParams {
            path: PathBuf::from(path),
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

    let conversation_id = resp.conversation_id.to_string();
    let initial_messages = resp.initial_messages.unwrap_or_default();

    let mut history_messages: Vec<ChatHistoryEntry> = initial_messages
        .iter()
        .filter_map(|event| serde_json::to_value(event).ok())
        .filter_map(|value| convert_history_item(&value))
        .collect();

    if history_messages.is_empty() && !fallback_history.is_empty() {
        history_messages = fallback_history;
    }

    let mut resume_events: Vec<(ChatEvent, Option<usize>)> = Vec::new();
    if !fallback_events.is_empty() {
        resume_events.extend(fallback_events.drain(..));
    }

    if !initial_messages.is_empty() {
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

    let _ = app.add_conversation_listener(conversation_id.clone()).await;
    Ok((
        conversation_id,
        history_messages,
        resume_events,
        resume_config,
    ))
}

pub async fn resume_conversation(
    Query(query): Query<ResumeQuery>,
    axum::extract::State(state): axum::extract::State<AppState>,
    maybe_body: Option<Json<ResumeBody>>,
) -> impl IntoResponse {
    let client = match get_or_start(Some(state.workspace_root.clone())).await {
        Ok(c) => c,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("Codex 未就绪：{}", e)).into_response(),
    };

    let body = maybe_body.map(|b| b.0).unwrap_or_default();
    let app = client.app();

    if let Some(path) = body.path.as_ref() {
        tracing::info!(target:"codex", path=%path, "HTTP resume → resumeConversation(explicit)");
        return match resume_from_path(&app, &state, path).await {
            Ok((conversation_id, history, events, config)) => {
                broadcast_resume(&state, &conversation_id, &history);
                (
                    StatusCode::OK,
                    Json(super::types::ResumeResponsePayload {
                        conversation_id,
                        history: if query.include_history.unwrap_or(false) {
                            history
                        } else {
                            Vec::new()
                        },
                        events: events.into_iter().map(into_resume_event_payload).collect(),
                        config,
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
        if let Some(path) = lookup_path_by_conversation_id(&app, conversation_id).await {
            return match resume_from_path(&app, &state, &path).await {
                Ok((conversation_id, history, events, config)) => {
                    broadcast_resume(&state, &conversation_id, &history);
                    (
                        StatusCode::OK,
                        Json(super::types::ResumeResponsePayload {
                            conversation_id,
                            history: if query.include_history.unwrap_or(false) {
                                history
                            } else {
                                Vec::new()
                            },
                            events: events.into_iter().map(into_resume_event_payload).collect(),
                            config,
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

    if let Ok(list) = app
        .list_conversations(ListConversationsParams {
            page_size: Some(1),
            cursor: None,
        })
        .await
    {
        if let Some(first) = list.items.first() {
            if let Ok(first_value) = serde_json::to_value(first) {
                if let Some(path) = conversation_path_of(&first_value) {
                    tracing::info!(target:"codex", path=%path, "HTTP resume → resumeConversation(latest)");
                    return match resume_from_path(&app, &state, &path).await {
                        Ok((conversation_id, history, events, config)) => {
                            broadcast_resume(&state, &conversation_id, &history);
                            (
                                StatusCode::OK,
                                Json(super::types::ResumeResponsePayload {
                                    conversation_id,
                                    history: if query.include_history.unwrap_or(false) {
                                        history
                                    } else {
                                        Vec::new()
                                    },
                                    events: events
                                        .into_iter()
                                        .map(into_resume_event_payload)
                                        .collect(),
                                    config,
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
