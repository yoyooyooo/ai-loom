use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::state::AppState;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeQuery {
    pub provider: Option<String>,
}

pub async fn get_runtime_snapshot(
    Query(query): Query<RuntimeQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let items = state
        .runtime_registry
        .runtime_snapshots(query.provider.as_deref())
        .await;
    (StatusCode::OK, Json(json!({ "items": items }))).into_response()
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WarmQuery {
    pub provider: Option<String>,
}

pub async fn warm_runtime(
    Path(conversation_id): Path<String>,
    Query(query): Query<WarmQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let provider = query.provider.as_deref().unwrap_or("codex");
    match state
        .runtime_registry
        .warm_conversation(provider, &conversation_id)
        .await
    {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub async fn delete_runtime_process(
    Path(conversation_id): Path<String>,
    Query(query): Query<WarmQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let provider = query.provider.as_deref().unwrap_or("codex");
    match state
        .runtime_registry
        .terminate_conversation(provider, &conversation_id)
        .await
    {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}
