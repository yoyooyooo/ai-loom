use std::path::PathBuf;

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use tokio::fs;

use crate::state::AppState;

use super::utils::resolve_rollout_path;

#[derive(Debug, Deserialize)]
pub struct DeleteConversationRequest {
    pub path: String,
}

pub async fn delete_conversation(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(body): Json<DeleteConversationRequest>,
) -> impl IntoResponse {
    let trimmed = body.path.trim();
    if trimmed.is_empty() {
        return StatusCode::BAD_REQUEST;
    }

    match resolve_rollout_path(trimmed, &state.workspace_root) {
        Some(path) => remove_file(path).await,
        None => StatusCode::BAD_REQUEST,
    }
}

async fn remove_file(path: PathBuf) -> StatusCode {
    match fs::remove_file(&path).await {
        Ok(_) => StatusCode::NO_CONTENT,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => StatusCode::NO_CONTENT,
        Err(err) => {
            tracing::warn!(target: "chat", file=%path.display(), error=%err, "删除会话文件失败");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}
