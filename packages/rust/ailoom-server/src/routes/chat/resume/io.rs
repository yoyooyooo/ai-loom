use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::routes::chat::utils::{conversation_id_of, normalize_conversation_item};
use crate::services::codex::client::AppServerClient;

use codex_app_server_protocol::ListConversationsParams;

fn codex_home() -> Option<PathBuf> {
    let path = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")));
    if let Some(ref p) = path {
        if p.exists() {
            return Some(p.clone());
        }
    }
    None
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
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(id) = val.get("session_id").and_then(|v| v.as_str()) {
                    if let Some(path_str) = val.get("rollout_path").and_then(|v| v.as_str()) {
                        pairs.push((id.to_string(), PathBuf::from(path_str)));
                        continue;
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
