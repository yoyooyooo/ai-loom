use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use codex_app_server_protocol::ListConversationsParams;
use serde_json::{Map, Value};

use super::client::AppServerClient;

fn codex_home() -> Option<PathBuf> {
    let path = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")));
    path.filter(|p| p.exists())
}

fn history_log_path(home: &Path) -> PathBuf {
    home.join("history.jsonl")
}

fn sessions_root(home: &Path) -> PathBuf {
    home.join("sessions")
}

fn parse_history_jsonl(home: &Path) -> Vec<(String, PathBuf)> {
    let path = history_log_path(home);
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let reader = BufReader::new(file);
    let mut pairs = Vec::new();
    for line_res in reader.lines() {
        if let Ok(line) = line_res {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(val) = serde_json::from_str::<Value>(&line) {
                if let Some(id) = val.get("session_id").and_then(|v| v.as_str()) {
                    if let Some(path_str) = val.get("rollout_path").and_then(|v| v.as_str()) {
                        pairs.push((id.to_string(), PathBuf::from(path_str)));
                    }
                }
            }
        }
    }
    pairs
}

fn find_in_sessions(home: &Path, conversation_id: &str) -> Option<PathBuf> {
    let mut queue = VecDeque::new();
    queue.push_back(sessions_root(home));

    while let Some(dir) = queue.pop_front() {
        if !dir.exists() {
            continue;
        }
        let read_dir = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry_res in read_dir {
            if let Ok(entry) = entry_res {
                let path = entry.path();
                if path.is_dir() {
                    queue.push_back(path);
                } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                    if let Some(file_name) = path.file_name().and_then(|s| s.to_str()) {
                        if file_name.contains(conversation_id) {
                            return Some(path);
                        }
                    }
                }
            }
        }
    }
    None
}

pub async fn lookup_path_by_conversation_id(
    app: &AppServerClient,
    conversation_id: &str,
) -> Option<String> {
    if let Some(home) = codex_home() {
        if let Some((_, path)) = parse_history_jsonl(&home)
            .into_iter()
            .find(|(id, _)| id == conversation_id)
        {
            return Some(path.to_string_lossy().to_string());
        }

        if let Some(path) = find_in_sessions(&home, conversation_id) {
            return Some(path.to_string_lossy().to_string());
        }
    }

    let mut cursor: Option<String> = None;
    loop {
        let response = match app
            .list_conversations(ListConversationsParams {
                page_size: Some(50),
                cursor: cursor.clone(),
                ..Default::default()
            })
            .await
        {
            Ok(v) => v,
            Err(_) => return None,
        };

        for item in &response.items {
            if let Ok(item_value) = serde_json::to_value(item) {
                if let Some(id) = conversation_id_of(&item_value) {
                    if id == conversation_id {
                        return normalize_conversation_item(&item_value)
                            .get("path")
                            .and_then(|p| p.as_str())
                            .map(|s| s.to_string());
                    }
                }
            }
        }

        cursor = response.next_cursor.clone();
        if cursor.is_none() {
            break;
        }
    }
    None
}

fn conversation_id_of(raw: &Value) -> Option<String> {
    raw.get("conversation_id")
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("conversationId").and_then(|v| v.as_str()))
        .or_else(|| raw.get("id").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

fn normalize_conversation_item(raw: &Value) -> Value {
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
