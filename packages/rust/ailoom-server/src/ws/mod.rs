pub mod protocol;
pub mod hub;
pub mod config;
mod conn;
mod methods;
pub mod watch;

use axum::{extract::ws::WebSocketUpgrade, response::IntoResponse, http::HeaderMap};
use crate::state::AppState;

/// Axum handler to upgrade to WebSocket and spawn connection task.
pub async fn ws_upgrade_handler(
  headers: HeaderMap,
  ws: WebSocketUpgrade,
  axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
  tracing::info!(target: "ws", "connection upgrading");
  if !origin_allowed(&headers) {
    return axum::http::StatusCode::FORBIDDEN.into_response();
  }
  ws.on_upgrade(move |socket| async move {
    conn::handle_connection(state, socket).await;
  })
}

fn origin_allowed(headers: &HeaderMap) -> bool {
  let allow_any = std::env::var("AILOOM_WS_ALLOW_ANY_ORIGIN").unwrap_or_else(|_| "1".into()) == "1";
  if allow_any { return true; }
  let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else { return false; };
  let allow_list = std::env::var("AILOOM_WS_ALLOWED_ORIGINS").unwrap_or_default();
  if allow_list.is_empty() { return true; }
  let items: Vec<&str> = allow_list.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
  items.iter().any(|&pat| pat == origin)
}
