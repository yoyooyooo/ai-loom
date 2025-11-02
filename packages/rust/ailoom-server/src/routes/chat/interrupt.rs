use crate::state::AppState;
use axum::{
    extract::Path, extract::Query, extract::State, http::StatusCode, response::IntoResponse, Json,
};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;
use tokio::time::Instant;

#[derive(Debug, Default, Deserialize)]
pub struct InterruptQuery {
    #[serde(rename = "await")]
    pub await_param: Option<String>,
    #[serde(default)]
    pub hard: Option<String>, // hard=1|true 触发“强制停止（重启引擎）”
    #[serde(default)]
    pub provider: Option<String>,
}

pub async fn interrupt_conversation(
    Path(conversation_id): Path<String>,
    Query(query): Query<InterruptQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let provider = query.provider.as_deref().unwrap_or("codex").to_string();
    // Hard-stop: 直接终止该会话的子进程（不影响其它会话）
    if matches!(query.hard.as_deref(), Some("1" | "true" | "yes")) {
        tracing::warn!(target:"codex", conversationId=%conversation_id, "HTTP interrupt (hard) → kill per-conv child");
        let _ = state
            .runtime_registry
            .terminate_conversation(&provider, &conversation_id)
            .await;
        return (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "status": "hard_stopped" })),
        )
            .into_response();
    }
    tracing::info!(target:"codex", conversationId=%conversation_id, "HTTP interrupt → interruptConversation");
    let await_turn_aborted = match query.await_param.as_deref() {
        Some("turnAborted") | Some("1") | Some("true") => true,
        _ => false,
    };

    // Await 模式：保持原语义（同步等待 Codex 确认中止）
    if await_turn_aborted {
        match state
            .runtime_registry
            .interrupt_conversation(&provider, &conversation_id)
            .await
        {
            Ok(()) => {
                return (StatusCode::OK, Json(json!({ "status": "interrupted" }))).into_response();
            }
            Err(e) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    format!("interruptConversation 等待失败：{}", e),
                )
                    .into_response();
            }
        }
    }

    // Auto 模式：非阻塞返回，后台 3 秒内未收束则强停 + 预热
    // 1) 立刻触发软中止（JSON-RPC），不等待
    {
        let cid = conversation_id.clone();
        let runtime_registry = state.runtime_registry.clone();
        let provider_clone = provider.clone();
        tokio::spawn(async move {
            let _ = runtime_registry
                .interrupt_conversation(&provider_clone, &cid)
                .await;
        });
    }

    // 2) 后台 watchdog：等待会话收束事件或超时
    if let Some(hub) = state.ws_hub.clone() {
        let cid = conversation_id.clone();
        let runtime_registry = state.runtime_registry.clone();
        let provider_clone = provider.clone();
        tokio::spawn(async move {
            let mut rx = hub.subscribe();
            let deadline = Instant::now() + Duration::from_millis(3000);
            let mut finished = false;
            loop {
                tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(deadline) => { break; }
                    msg = rx.recv() => {
                        if let Ok(ev) = msg {
                            let method = ev.method.as_str();
                            if method == "chat.message.aborted" || method == "chat.message.completed" || method == "chat.message.failed" || method == "chat.turn.complete" {
                                let conv = ev.params.get("conversationId").and_then(|v| v.as_str()).unwrap_or("");
                                if conv == cid { finished = true; break; }
                            }
                        } else {
                            break;
                        }
                    }
                }
            }
            if finished {
                return;
            }
            // 3) 超时：广播 aborted（reason=hard_stop），强制结束该会话子进程，并提示前端
            hub.broadcast(
                "chat.message.aborted".into(),
                json!({ "conversationId": cid, "reason": "hard_stop" }),
            );
            let _ = runtime_registry
                .terminate_conversation(&provider_clone, &cid)
                .await;
            // 提示前端（toast 提示用）
            hub.broadcast(
                "chat.info.background".into(),
                json!({
                    "conversationId": cid,
                    "message": "conversation engine hard-stopped",
                    "code": "engine_hard_stopped"
                }),
            );
        });
    }

    (StatusCode::ACCEPTED, Json(json!({"status":"accepted"}))).into_response()
}
