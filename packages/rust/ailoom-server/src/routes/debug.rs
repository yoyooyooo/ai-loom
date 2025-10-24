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

    Json(CodexDebugResponse { stats, events }).into_response()
}
