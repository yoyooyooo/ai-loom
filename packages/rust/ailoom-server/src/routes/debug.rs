use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use crate::{state::AppState, ws::hub::HubStatsOut};
use ailoom_executors::providers::codex::{active_conversation_ids, current as codex_current};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDebugQuery {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub include_chat: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexDebugEvent {
    id: u64,
    method: String,
    params: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexDebugResponse {
    stats: HubStatsOut,
    events: Vec<CodexDebugEvent>,
    codex: serde_json::Value,
}

pub async fn codex_debug(
    State(state): State<AppState>,
    Query(query): Query<CodexDebugQuery>,
) -> impl IntoResponse {
    let Some(hub) = state.ws_hub.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "websocket hub unavailable").into_response();
    };

    let stats = hub.stats_snapshot();

    let mut limit = query.limit.unwrap_or(200);
    if limit == 0 {
        limit = 1;
    } else if limit > 1000 {
        limit = 1000;
    }

    // 预取 2 倍以便过滤后仍有足够样本
    let raw_events = hub.tail(limit * 2);
    let include_chat = query.include_chat.unwrap_or(true);

    let events = raw_events
        .into_iter()
        .filter(|ev| {
            ev.method.starts_with("codex/") || (include_chat && ev.method.starts_with("chat."))
        })
        .take(limit)
        .map(|ev| CodexDebugEvent {
            id: ev.id,
            method: ev.method,
            params: ev.params,
        })
        .collect::<Vec<_>>();

    // Codex client 状态快照
    let registry_snapshots = state
        .runtime_registry
        .runtime_snapshots(Some("codex"))
        .await;

    let codex_json = match codex_current().await {
        Some(client) => {
            let alive = client.is_alive().await;
            let app = client.app();
            let subs = app
                .subscriptions_snapshot()
                .into_iter()
                .map(|(cid, refcnt)| serde_json::json!({"conversationId": cid, "refCount": refcnt}))
                .collect::<Vec<_>>();
            let active = app.active_conversations_snapshot();
            let bridge_active = active_conversation_ids();
            serde_json::json!({
                "alive": alive,
                "subscriptions": subs,
                "activeConversations": active,
                "bridgeActiveConversations": bridge_active,
                "runtime": registry_snapshots,
            })
        }
        None => {
            serde_json::json!({"alive": false, "subscriptions": [], "activeConversations": [], "bridgeActiveConversations": [], "runtime": registry_snapshots})
        }
    };

    Json(CodexDebugResponse {
        stats,
        events,
        codex: codex_json,
    })
    .into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsConnDebug {
    conn_id: u64,
    subs: Vec<crate::ws::inspect::WsSubSnapshot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsDebugResponse {
    connections: Vec<WsConnDebug>,
}

pub async fn ws_debug() -> impl IntoResponse {
    let snap = crate::ws::inspect::snapshot();
    let list = snap
        .into_iter()
        .map(|c| WsConnDebug {
            conn_id: c.conn_id,
            subs: c.subs,
        })
        .collect::<Vec<_>>();
    Json(WsDebugResponse { connections: list }).into_response()
}
