use crate::state::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
pub struct SendBody {
    pub text: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuery {
    pub provider: Option<String>,
}

pub async fn send_message(
    Path(conversation_id): Path<String>,
    Query(query): Query<ProviderQuery>,
    State(state): State<AppState>,
    Json(body): Json<SendBody>,
) -> impl IntoResponse {
    let text = body.text.trim().to_string();
    if text.is_empty() {
        return (StatusCode::BAD_REQUEST, "消息不能为空").into_response();
    }
    let provider = query.provider.as_deref().unwrap_or("codex").to_string();
    tracing::info!(
        target:"codex",
        conversationId=%conversation_id,
        len=text.len(),
        preview=%text.chars().take(40).collect::<String>(),
        "HTTP send received"
    );
    // 每会话子进程：必要时 spawn_resume，然后发送
    // 1) 立即向前端回显“用户消息已受理”，避免无推送时的空窗疑惑（入环）
    if let Some(hub) = state.ws_hub.clone() {
        hub.broadcast(
            "chat.info.user_message".into(),
            json!({"conversationId": conversation_id, "text": text}),
        );
    }

    // 2) 后台确保监听并发送，避免阻塞 HTTP
    let hub = state.ws_hub.clone();
    let runtime_registry = state.runtime_registry.clone();
    let cid_for_task = conversation_id.clone();
    let text_for_task = text.clone();
    tokio::spawn(async move {
        let provider_name = provider;
        let started = std::time::Instant::now();
        tracing::info!(target:"codex", conversationId=%cid_for_task, "HTTP send (bg) task started");
        // per-conv：若该会话已由本服务托管（存在子进程），跳过 ensure_listener
        let need_ensure = runtime_registry
            .is_runtime_alive(&provider_name, &cid_for_task)
            .await
            .map(|alive| !alive)
            .unwrap_or(true);
        if need_ensure {
            // 确保已监听该会话（即使会话不是由本服务 new/resume 创建）。失败时仅提示，不中断后续重试机会。
            if let Err(e) = runtime_registry
                .warm_conversation(&provider_name, &cid_for_task)
                .await
            {
                if let Some(h) = hub.clone() {
                    h.broadcast(
                        "chat.info.background".into(),
                        json!({
                            "conversationId": cid_for_task,
                            "message": format!("已接收消息，但监听未就绪：{}", e)
                        }),
                    );
                }
                // 监听未就绪时，仍尝试直接发送，由 Codex 侧自行恢复
            }
        }
        tracing::info!(
            target:"codex",
            conversationId=%cid_for_task,
            ms=%started.elapsed().as_millis(),
            "HTTP send (bg) ensure_listener finished"
        );
        tracing::info!(
            target:"codex",
            conversationId=%cid_for_task,
            len=text_for_task.len(),
            preview=%text_for_task.chars().take(40).collect::<String>(),
            "HTTP send → sendUserMessage (bg)"
        );
        if let Err(e) = runtime_registry
            .send_user_message(&provider_name, &cid_for_task, &text_for_task)
            .await
        {
            if let Some(h) = hub.clone() {
                h.broadcast(
                    "chat.message.failed".into(),
                    json!({
                        "conversationId": cid_for_task,
                        "error": { "message": format!("{}", e) }
                    }),
                );
            }
        } else {
            tracing::info!(target:"codex", conversationId=%cid_for_task, "HTTP send (bg) sendUserMessage returned ok");
        }
    });

    // 3) 立刻返回 JSON，交由 WS 推送驱动 UI
    (
        StatusCode::ACCEPTED,
        Json(json!({"status":"accepted","conversationId": conversation_id})),
    )
        .into_response()
}
