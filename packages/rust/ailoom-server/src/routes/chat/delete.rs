use std::path::{Path, PathBuf};

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::Value;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, BufReader};

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
        Some(path) => delete_rollout_with_history(path).await,
        None => StatusCode::BAD_REQUEST,
    }
}

async fn delete_rollout_with_history(path: PathBuf) -> StatusCode {
    let canonical_path = match fs::canonicalize(&path).await {
        Ok(p) => p,
        Err(_) => path.clone(),
    };

    let session_id = match derive_session_id_from_rollout(&path).await {
        Some(id) => Some(id),
        None => derive_session_id_from_path(&path),
    };

    if let Err(err) = remove_history_entries(&canonical_path, session_id.as_deref()).await {
        tracing::warn!(
            target: "chat",
            file = %canonical_path.display(),
            error = %err,
            "删除会话记录时更新 history.jsonl 失败"
        );
    }

    match fs::remove_file(&path).await {
        Ok(_) => StatusCode::NO_CONTENT,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => StatusCode::NO_CONTENT,
        Err(err) => {
            tracing::warn!(target: "chat", file=%path.display(), error=%err, "删除会话文件失败");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

async fn derive_session_id_from_rollout(path: &Path) -> Option<String> {
    let file = fs::File::open(path).await.ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).await.ok()?;
        if read == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(payload) = value.get("payload") {
            if let Some(id) = payload.get("id").and_then(|v| v.as_str()) {
                return Some(id.to_string());
            }
        }
        if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
            return Some(id.to_string());
        }
    }
    None
}

fn derive_session_id_from_path(path: &Path) -> Option<String> {
    let file_name = path.file_name()?.to_str()?.trim_end_matches(".jsonl");
    let parts: Vec<&str> = file_name.split('-').collect();
    if parts.len() < 5 {
        return None;
    }
    for window in parts.windows(5).rev() {
        let candidate = window.join("-");
        if uuid::Uuid::parse_str(&candidate).is_ok() {
            return Some(candidate);
        }
    }
    None
}

async fn remove_history_entries(
    path: &Path,
    session_id: Option<&str>,
) -> Result<(), std::io::Error> {
    let Some(history_path) = history_jsonl_path() else {
        return Ok(());
    };

    let Ok(content) = fs::read_to_string(&history_path).await else {
        return Ok(());
    };

    let mut modified = false;
    let mut buffer = String::with_capacity(content.len());

    for raw_line in content.split_inclusive('\n') {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            buffer.push_str(raw_line);
            continue;
        }

        let matches_target = matches_history_entry(trimmed, path, session_id);
        match matches_target {
            Some(true) => {
                modified = true;
            }
            Some(false) | None => {
                buffer.push_str(raw_line);
            }
        }
    }

    if modified {
        if !buffer.ends_with('\n') {
            buffer.push('\n');
        }
        fs::write(&history_path, buffer).await?;
    }

    Ok(())
}

fn matches_history_entry(line: &str, path: &Path, session_id: Option<&str>) -> Option<bool> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return None;
    };

    if let Some(id) = session_id {
        if value
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s == id)
            .unwrap_or(false)
        {
            return Some(true);
        }
    }

    if let Some(rollout) = value.get("rollout_path").and_then(|v| v.as_str()) {
        let normalized = normalize_history_path(rollout);
        if normalized == path.to_string_lossy() {
            return Some(true);
        }
    }

    Some(false)
}

fn normalize_history_path(raw: &str) -> String {
    if let Some(stripped) = raw.strip_prefix("file://") {
        stripped.to_string()
    } else {
        raw.to_string()
    }
}

fn history_jsonl_path() -> Option<PathBuf> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|dir| dir.join(".codex")));
    let Some(home) = home else {
        return None;
    };
    let history = home.join("history.jsonl");
    if history.exists() {
        Some(history)
    } else {
        None
    }
}
