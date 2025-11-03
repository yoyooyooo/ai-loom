use std::path::PathBuf;

use ailoom_executors::{ConversationTurn, SandboxOverrides};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use codex_protocol::config_types::{ReasoningEffort, ReasoningSummary, SandboxMode};
use codex_protocol::protocol::AskForApproval;
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

use super::send::ProviderQuery;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendTurnBody {
    text: String,
    model: Option<String>,
    approval_policy: Option<AskForApproval>,
    sandbox_mode: Option<SandboxMode>,
    sandbox_writable_roots: Option<Vec<String>>,
    sandbox_network_access: Option<bool>,
    sandbox_exclude_tmpdir_env_var: Option<bool>,
    sandbox_exclude_slash_tmp: Option<bool>,
    effort: Option<ReasoningEffort>,
    summary: Option<ReasoningSummary>,
}

pub async fn send_turn(
    Path(conversation_id): Path<String>,
    Query(query): Query<ProviderQuery>,
    State(state): State<AppState>,
    Json(body): Json<SendTurnBody>,
) -> impl IntoResponse {
    let SendTurnBody {
        text,
        model,
        approval_policy,
        sandbox_mode,
        sandbox_writable_roots,
        sandbox_network_access,
        sandbox_exclude_tmpdir_env_var,
        sandbox_exclude_slash_tmp,
        effort,
        summary,
    } = body;

    let trimmed_text = text.trim().to_string();
    if trimmed_text.is_empty() {
        return (StatusCode::BAD_REQUEST, "消息不能为空").into_response();
    }

    let provider = query.provider.as_deref().unwrap_or("codex").to_string();
    if let Some(hub) = state.ws_hub.clone() {
        hub.broadcast(
            "chat.info.user_message".into(),
            json!({
                "conversationId": conversation_id,
                "text": trimmed_text,
            }),
        );
    }

    let sandbox = sandbox_mode.map(|mode| SandboxOverrides {
        mode,
        writable_roots: sandbox_writable_roots
            .map(|roots| roots.into_iter().map(PathBuf::from).collect()),
        network_access: sandbox_network_access,
        exclude_tmpdir_env_var: sandbox_exclude_tmpdir_env_var,
        exclude_slash_tmp: sandbox_exclude_slash_tmp,
    });

    let turn = ConversationTurn {
        text: trimmed_text.clone(),
        model,
        approval_policy,
        sandbox,
        effort,
        summary,
        cwd: Some(state.workspace_root.clone()),
    };

    let hub = state.ws_hub.clone();
    let ensure_needed = state
        .runtime_registry
        .is_runtime_alive(&provider, &conversation_id)
        .await
        .map(|alive| !alive)
        .unwrap_or(true);
    if ensure_needed {
        if let Err(err) = state
            .runtime_registry
            .warm_conversation(&provider, &conversation_id)
            .await
        {
            if let Some(h) = hub.clone() {
                h.broadcast(
                    "chat.info.background".into(),
                    json!({
                        "conversationId": conversation_id,
                        "message": format!("已接收消息，但监听未就绪：{}", err)
                    }),
                );
            }
        }
    }

    match state
        .runtime_registry
        .send_user_turn(&provider, &conversation_id, turn)
        .await
    {
        Ok(_) => (
            StatusCode::ACCEPTED,
            Json(json!({
                "status": "accepted",
                "conversationId": conversation_id
            })),
        )
            .into_response(),
        Err(err) => {
            if let Some(h) = hub {
                h.broadcast(
                    "chat.message.failed".into(),
                    json!({
                        "conversationId": conversation_id,
                        "error": { "message": err.to_string() }
                    }),
                );
            }
            match err {
                ailoom_executors::ProviderError::Unsupported(message) => {
                    (StatusCode::NOT_IMPLEMENTED, message).into_response()
                }
                ailoom_executors::ProviderError::InvalidRequest(message) => {
                    (StatusCode::BAD_REQUEST, message).into_response()
                }
                _ => (StatusCode::BAD_GATEWAY, format!("发送失败：{}", err)).into_response(),
            }
        }
    }
}
