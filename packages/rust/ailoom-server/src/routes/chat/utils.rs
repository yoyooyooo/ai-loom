use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use dirs::home_dir;
use serde_json::{Map, Value};
use std::fs::File;
use std::io::{BufRead, BufReader};

const FIRST_USER_PREVIEW_MAX_CHARS: usize = 160;

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

/// 返回 (depth, parentId, rootId)
/// depth = 顶部连续 session_meta 数量 - 1（根为 0）
/// parentId = 顶部第 2 条 session_meta 的 id（若存在）
/// rootId = 顶部连续 session_meta 列表的最后一条 id（若存在）
pub fn derive_lineage_from_rollout(path: &Path) -> Option<(i64, Option<String>, Option<String>)> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut ids: Vec<String> = Vec::new();
    for line in reader.lines().take(32) {
        let Ok(l) = line else { break };
        let s = l.trim();
        if s.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(s) else {
            break;
        };
        let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if t == "session_meta" {
            if let Some(id) = v
                .get("payload")
                .and_then(|p| p.get("id"))
                .and_then(|x| x.as_str())
            {
                ids.push(id.to_string());
            } else {
                // 没有 id 的 meta，终止
                break;
            }
        } else {
            break;
        }
    }
    if ids.is_empty() {
        return None;
    }
    let depth = (ids.len() as i64) - 1;
    let parent = if ids.len() >= 2 {
        Some(ids[1].clone())
    } else {
        None
    };
    let root = ids.last().cloned();
    Some((depth, parent, root))
}

/// 从 rollout JSONL 推导会话轮次（turns）。
/// 定义：一次用户 `user_message` 后，若后续出现一次 `agent_message`，计为 1 个 turn。
/// 中间可能夹杂 `agent_reasoning` 等事件；连续多条 `agent_message` 只配对最近一次待配对的 `user_message`。
pub fn derive_turns_from_rollout(path: &Path) -> Option<i64> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut turns: i64 = 0;
    let mut awaiting_assistant = false;
    for line in reader.lines() {
        let Ok(l) = line else { continue };
        let s = l.trim();
        if s.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(s) else {
            continue;
        };
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if kind != "event_msg" {
            continue;
        }
        let Some(payload) = v.get("payload") else {
            continue;
        };
        let ptype = payload.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match ptype {
            "user_message" => {
                // 新的用户消息，等待一条 assistant 消息来配对
                awaiting_assistant = true;
            }
            "agent_message" => {
                if awaiting_assistant {
                    turns += 1;
                    awaiting_assistant = false;
                }
            }
            _ => {}
        }
    }
    Some(turns)
}

fn clamp_preview(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let collapsed = trimmed
        .split_whitespace()
        .fold(String::new(), |mut acc, part| {
            if !part.is_empty() {
                if !acc.is_empty() {
                    acc.push(' ');
                }
                acc.push_str(part);
            }
            acc
        });
    if collapsed.chars().count() <= FIRST_USER_PREVIEW_MAX_CHARS {
        return collapsed;
    }
    collapsed
        .chars()
        .take(FIRST_USER_PREVIEW_MAX_CHARS)
        .collect::<String>()
        + "…"
}

fn extract_user_message_text(payload: &Value) -> Option<String> {
    if let Some(msg) = payload
        .get("message")
        .and_then(|m| m.as_str())
        .filter(|m| !m.trim().is_empty())
    {
        return Some(clamp_preview(msg));
    }

    if let Some(text) = payload
        .get("text")
        .and_then(|t| t.as_str())
        .filter(|t| !t.trim().is_empty())
    {
        return Some(clamp_preview(text));
    }

    if let Some(content_items) = payload.get("content") {
        if let Some(arr) = content_items.as_array() {
            let mut pieces: Vec<String> = Vec::new();
            for item in arr {
                if let Some(kind) = item.get("type").and_then(|k| k.as_str()) {
                    match kind {
                        "input_text" | "text" => {
                            if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                let normalized = clamp_preview(text);
                                if !normalized.is_empty() {
                                    pieces.push(normalized);
                                }
                            }
                        }
                        _ => {}
                    }
                } else if let Some(as_str) = item.as_str() {
                    let normalized = clamp_preview(as_str);
                    if !normalized.is_empty() {
                        pieces.push(normalized);
                    }
                }
            }
            if !pieces.is_empty() {
                let mut merged = pieces.join(" ");
                if merged.chars().count() > FIRST_USER_PREVIEW_MAX_CHARS {
                    merged = merged
                        .chars()
                        .take(FIRST_USER_PREVIEW_MAX_CHARS)
                        .collect::<String>()
                        + "…";
                }
                return Some(merged);
            }
        } else if let Some(text) = content_items.as_str() {
            let normalized = clamp_preview(text);
            if !normalized.is_empty() {
                return Some(normalized);
            }
        }
    }

    None
}

pub fn derive_first_user_message_from_rollout(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines() {
        let Ok(line) = line else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if value
            .get("type")
            .and_then(|x| x.as_str())
            .filter(|t| *t == "event_msg")
            .is_none()
        {
            continue;
        }
        let Some(payload) = value.get("payload") else {
            continue;
        };
        if payload
            .get("type")
            .and_then(|x| x.as_str())
            .filter(|t| *t == "user_message")
            .is_none()
        {
            continue;
        }
        if let Some(text) = extract_user_message_text(payload) {
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        derive_first_user_message_from_rollout, derive_lineage_from_rollout,
        derive_turns_from_rollout,
    };
    use std::fs;
    use std::path::Path;
    use std::path::PathBuf;

    fn tmpfile(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ailoom_depth_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn derive_depth(path: &Path) -> Option<i64> {
        derive_lineage_from_rollout(path).map(|(depth, _, _)| depth)
    }

    #[test]
    fn depth_is_count_minus_one_for_contiguous_session_meta() {
        let p = tmpfile("a.jsonl");
        let content = r#"
{"type":"session_meta","payload":{"id":"A"}}
{"type":"session_meta","payload":{"id":"B"}}
{"type":"session_meta","payload":{"id":"C"}}
{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}
"#;
        fs::write(&p, content.trim_start()).unwrap();
        let d = derive_depth(&p).expect("some depth");
        assert_eq!(d, 2);
    }

    #[test]
    fn stops_counting_on_first_non_session_meta() {
        let p = tmpfile("b.jsonl");
        let content = r#"
{"type":"session_meta","payload":{"id":"A"}}
{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}
{"type":"session_meta","payload":{"id":"C"}}
"#;
        fs::write(&p, content.trim_start()).unwrap();
        let d = derive_depth(&p).expect("some depth");
        assert_eq!(d, 0);
    }

    #[test]
    fn returns_none_when_no_session_meta_at_top() {
        let p = tmpfile("c.jsonl");
        let content = r#"
{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}
{"type":"session_meta","payload":{"id":"C"}}
"#;
        fs::write(&p, content.trim_start()).unwrap();
        let d = derive_depth(&p);
        assert!(d.is_none());
    }

    #[test]
    fn derive_parent_and_root_ids() {
        let p = tmpfile("d.jsonl");
        let content = r#"
{"type":"session_meta","payload":{"id":"NEW"}}
{"type":"session_meta","payload":{"id":"PARENT"}}
{"type":"session_meta","payload":{"id":"ROOT"}}
{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}
"#;
        fs::write(&p, content.trim_start()).unwrap();
        let (depth, parent, root) = derive_lineage_from_rollout(&p).expect("lineage");
        assert_eq!(depth, 2);
        assert_eq!(parent.as_deref(), Some("PARENT"));
        assert_eq!(root.as_deref(), Some("ROOT"));
    }

    #[test]
    fn derive_turns_basic_pairs() {
        let p = tmpfile("turns.jsonl");
        let content = r#"
{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}
{"type":"event_msg","payload":{"type":"agent_reasoning","text":"thinking"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"hello"}}
{"type":"event_msg","payload":{"type":"user_message","message":"again"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"ok"}}
"#;
        fs::write(&p, content.trim_start()).unwrap();
        let t = derive_turns_from_rollout(&p).expect("some turns");
        assert_eq!(t, 2);
    }

    #[test]
    fn derive_turns_does_not_overcount_multiple_assistant_msgs() {
        let p = tmpfile("turns2.jsonl");
        let content = r#"
{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"hello"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"and another"}}
"#;
        fs::write(&p, content.trim_start()).unwrap();
        let t = derive_turns_from_rollout(&p).expect("some turns");
        assert_eq!(t, 1);
    }

    #[test]
    fn derive_first_user_message_reads_first_non_empty_user_text() {
        let p = tmpfile("preview.jsonl");
        let content = r#"
{"type":"session_meta","payload":{"id":"root"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"ignore"}}
{"type":"event_msg","payload":{"type":"user_message","message":" first line \n second "}}
{"type":"event_msg","payload":{"type":"user_message","message":"later"}}
"#;
        fs::write(&p, content.trim_start()).unwrap();
        let preview = derive_first_user_message_from_rollout(&p).expect("some preview");
        assert_eq!(preview, "first line second");
    }

    #[test]
    fn derive_first_user_message_handles_structured_content() {
        let p = tmpfile("preview2.jsonl");
        let content = r#"
{"type":"event_msg","payload":{"type":"user_message","content":[{"type":"input_text","text":"hello"},{"type":"input_text","text":"world"}]}}
"#;
        fs::write(&p, content.trim_start()).unwrap();
        let preview = derive_first_user_message_from_rollout(&p).expect("some preview");
        assert_eq!(preview, "hello world");
    }
}
