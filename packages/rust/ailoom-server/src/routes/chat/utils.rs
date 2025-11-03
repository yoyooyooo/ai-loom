use axum::http::StatusCode;
use dirs::home_dir;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub fn map_error_to_status(err: &str) -> StatusCode {
    if err.contains("timeout") {
        StatusCode::GATEWAY_TIMEOUT
    } else if err.contains("not found") {
        StatusCode::NOT_FOUND
    } else if err.contains("invalid") {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

pub fn codex_not_reachable_hint() -> &'static str {
    "本地 Codex 不可达，请先运行 `npx -y @openai/codex app-server` 或完成 `npx -y @openai/codex login` 后重试"
}

pub fn conversation_id_of(raw: &Value) -> Option<String> {
    raw.get("conversation_id")
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("conversationId").and_then(|v| v.as_str()))
        .or_else(|| raw.get("id").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

pub fn conversation_path_of(raw: &Value) -> Option<String> {
    raw.get("path")
        .and_then(|p| p.as_str())
        .or_else(|| raw.get("rollout_path").and_then(|p| p.as_str()))
        .map(|s| s.to_string())
}

pub fn normalize_conversation_item(raw: &Value) -> Value {
    let mut map = Map::new();

    let path = raw
        .get("path")
        .and_then(|p| p.as_str())
        .or_else(|| raw.get("rollout_path").and_then(|p| p.as_str()))
        .unwrap_or_default()
        .to_string();
    map.insert("path".into(), Value::String(path));

    if let Some(id) = raw
        .get("conversation_id")
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("conversationId").and_then(|v| v.as_str()))
        .or_else(|| raw.get("id").and_then(|v| v.as_str()))
    {
        map.insert("conversationId".into(), Value::String(id.to_string()));
    }

    if let Some(parent) = raw
        .get("parent_id")
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("parentId").and_then(|v| v.as_str()))
    {
        map.insert("parentId".into(), Value::String(parent.to_string()));
    }

    if let Some(root) = raw
        .get("root_id")
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("rootId").and_then(|v| v.as_str()))
    {
        map.insert("rootId".into(), Value::String(root.to_string()));
    }

    if let Some(depth) = raw.get("depth").and_then(|d| d.as_i64()) {
        map.insert("depth".into(), Value::from(depth));
    }

    if let Some(created_at) = raw
        .get("created_at")
        .and_then(|t| t.as_str())
        .or_else(|| raw.get("createdAt").and_then(|t| t.as_str()))
    {
        map.insert("createdAt".into(), Value::String(created_at.to_string()));
    }

    let preview = raw
        .get("preview")
        .and_then(|p| p.as_str())
        .unwrap_or_default()
        .replace('\n', " ");
    map.insert("preview".into(), Value::String(preview));

    if let Some(model) = raw
        .get("model")
        .and_then(|m| m.as_str())
        .or_else(|| raw.get("model_provider").and_then(|m| m.as_str()))
        .or_else(|| raw.get("modelProvider").and_then(|m| m.as_str()))
    {
        map.insert("model".into(), Value::String(model.to_string()));
    }

    let timestamp = raw
        .get("timestamp")
        .and_then(|t| t.as_str())
        .or_else(|| raw.get("created_at").and_then(|t| t.as_str()))
        .unwrap_or_default()
        .to_string();
    map.insert("timestamp".into(), Value::String(timestamp));

    Value::Object(map)
}

pub fn resolve_rollout_path(raw: &str, workspace_root: &Path) -> Option<PathBuf> {
    if raw.is_empty() {
        return None;
    }
    let trimmed = raw.trim();
    if let Some(stripped) = trimmed.strip_prefix("file://") {
        let as_path = PathBuf::from(stripped);
        return Some(if as_path.is_absolute() {
            as_path
        } else {
            workspace_root.join(as_path)
        });
    }
    if trimmed.starts_with("~/") {
        if let Some(home) = home_dir() {
            return Some(home.join(trimmed.trim_start_matches("~/")));
        }
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        Some(path)
    } else {
        Some(workspace_root.join(path))
    }
}

#[cfg(test)]
mod tests {}
