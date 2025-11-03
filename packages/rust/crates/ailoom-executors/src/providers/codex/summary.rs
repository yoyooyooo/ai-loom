use once_cell::sync::Lazy;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tokio::sync::RwLock;

const FIRST_USER_PREVIEW_MAX_CHARS: usize = 160;
const HEAD_SCAN_LIMIT: usize = 256;

#[derive(Clone, Debug, Default)]
pub struct RolloutSummary {
    pub preview: Option<String>,
    pub depth: Option<i64>,
    pub parent_id: Option<String>,
    pub root_id: Option<String>,
    pub in_progress: Option<bool>,
}

#[derive(Clone)]
struct CachedSummary {
    mtime: Option<SystemTime>,
    summary: RolloutSummary,
}

static SUMMARY_CACHE: Lazy<RwLock<HashMap<PathBuf, CachedSummary>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

pub async fn load_rollout_summary(path: impl AsRef<Path>) -> std::io::Result<RolloutSummary> {
    let path_buf = path.as_ref().to_path_buf();
    let modified = std::fs::metadata(&path_buf)
        .ok()
        .and_then(|meta| meta.modified().ok());

    {
        let cache = SUMMARY_CACHE.read().await;
        if let Some(entry) = cache.get(&path_buf) {
            if entry.mtime == modified {
                return Ok(entry.summary.clone());
            }
        }
    }

    let compute_path = path_buf.clone();
    let summary = tokio::task::spawn_blocking(move || compute_summary(&compute_path, modified))
        .await
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err.to_string()))??;

    let mut cache = SUMMARY_CACHE.write().await;
    cache.insert(
        path_buf,
        CachedSummary {
            mtime: modified,
            summary: summary.clone(),
        },
    );

    Ok(summary)
}

pub async fn invalidate_rollout_summary(path: impl AsRef<Path>) {
    let mut cache = SUMMARY_CACHE.write().await;
    cache.remove(path.as_ref());
}

pub fn rollout_in_progress(path: impl AsRef<Path>) -> Option<bool> {
    let path_ref = path.as_ref();
    let modified = std::fs::metadata(path_ref)
        .ok()
        .and_then(|meta| meta.modified().ok());
    determine_in_progress(path_ref, modified)
}

pub fn derive_first_user_message_from_rollout(path: impl AsRef<Path>) -> Option<String> {
    read_head_info(path.as_ref())
        .ok()
        .and_then(|info| info.preview)
}

pub fn derive_lineage_from_rollout(
    path: impl AsRef<Path>,
) -> Option<(i64, Option<String>, Option<String>)> {
    let info = read_head_info(path.as_ref()).ok()?;
    if info.session_meta_ids.is_empty() {
        return None;
    }
    let depth = (info.session_meta_ids.len() as i64) - 1;
    let parent = if info.session_meta_ids.len() >= 2 {
        Some(info.session_meta_ids[1].clone())
    } else {
        None
    };
    let root = info.session_meta_ids.last().cloned();
    Some((depth, parent, root))
}

fn compute_summary(path: &Path, modified: Option<SystemTime>) -> std::io::Result<RolloutSummary> {
    let info = read_head_info(path)?;
    let (depth, parent_id, root_id) = if info.session_meta_ids.is_empty() {
        (None, None, None)
    } else {
        let depth = Some(info.session_meta_ids.len() as i64 - 1);
        let parent = if info.session_meta_ids.len() >= 2 {
            Some(info.session_meta_ids[1].clone())
        } else {
            None
        };
        let root = info.session_meta_ids.last().cloned();
        (depth, parent, root)
    };

    let in_progress = determine_in_progress(path, modified);

    Ok(RolloutSummary {
        preview: info.preview,
        depth,
        parent_id,
        root_id,
        in_progress,
    })
}

struct HeadInfo {
    preview: Option<String>,
    session_meta_ids: Vec<String>,
}

fn read_head_info(path: &Path) -> std::io::Result<HeadInfo> {
    let file = std::fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut preview: Option<String> = None;
    let mut session_meta_ids: Vec<String> = Vec::new();
    let mut still_session_meta = true;

    for (idx, line_res) in reader.lines().enumerate() {
        if idx >= HEAD_SCAN_LIMIT {
            break;
        }
        let line = line_res?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if still_session_meta {
            if kind == "session_meta" {
                if let Some(id) = value
                    .get("payload")
                    .and_then(|p| p.get("id"))
                    .and_then(|x| x.as_str())
                {
                    session_meta_ids.push(id.to_string());
                    continue;
                } else {
                    still_session_meta = false;
                }
            } else {
                still_session_meta = false;
            }
        }
        if preview.is_some() {
            continue;
        }
        if kind != "event_msg" {
            continue;
        }
        let Some(payload) = value.get("payload") else {
            continue;
        };
        if payload
            .get("type")
            .and_then(|t| t.as_str())
            .is_some_and(|t| t == "user_message")
        {
            preview = extract_user_message_text(payload);
            if preview.is_some() {
                break;
            }
        }
    }

    Ok(HeadInfo {
        preview,
        session_meta_ids,
    })
}

fn determine_in_progress(path: &Path, modified: Option<SystemTime>) -> Option<bool> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut lines: Vec<String> = Vec::new();
    for line in reader.lines().flatten() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            lines.push(trimmed.to_string());
        }
    }
    let mut closed_fn_calls: HashSet<String> = HashSet::new();
    let mut closed_exec_calls: HashSet<String> = HashSet::new();
    for raw in lines.iter().rev().take(4096) {
        let Ok(value) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        let kind = value.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if kind == "response_item" {
            let Some(payload) = value.get("payload") else {
                continue;
            };
            let ptype = payload.get("type").and_then(|x| x.as_str()).unwrap_or("");
            match ptype {
                "function_call_output" => {
                    if let Some(cid) = payload.get("call_id").and_then(|x| x.as_str()) {
                        closed_fn_calls.insert(cid.to_string());
                    }
                }
                "function_call" => {
                    if let Some(cid) = payload.get("call_id").and_then(|x| x.as_str()) {
                        if !closed_fn_calls.contains(cid) {
                            return Some(true);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if kind != "event_msg" {
            continue;
        }
        let Some(payload) = value.get("payload") else {
            continue;
        };
        let ptype = payload.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match ptype {
            "shutdown_complete" | "task_complete" | "turn_aborted" | "error" | "stream_error" => {
                return Some(false);
            }
            "exec_command_end" => {
                if let Some(cid) = payload.get("call_id").and_then(|x| x.as_str()) {
                    closed_exec_calls.insert(cid.to_string());
                }
            }
            "exec_command_begin" => {
                if let Some(cid) = payload.get("call_id").and_then(|x| x.as_str()) {
                    if !closed_exec_calls.contains(cid) {
                        return Some(true);
                    }
                }
            }
            "agent_message_delta" | "agent_reasoning_delta" => {
                return Some(true);
            }
            _ => {
                let threshold_ms: u64 = std::env::var("AILOOM_CODEX_ROLLOUT_IDLE_MS")
                    .ok()
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(8000);
                let modified_time = match modified {
                    Some(m) => Some(m),
                    None => std::fs::metadata(path).ok().and_then(|m| m.modified().ok()),
                };
                let idle_ms = modified_time
                    .and_then(|mt| SystemTime::now().duration_since(mt).ok())
                    .map(duration_to_millis)
                    .unwrap_or(threshold_ms + 1);
                if idle_ms >= threshold_ms {
                    return Some(false);
                }
                return Some(true);
            }
        }
    }
    None
}

fn duration_to_millis(duration: Duration) -> u64 {
    duration.as_millis() as u64
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

#[cfg(test)]
mod tests {
    use super::{
        derive_first_user_message_from_rollout, derive_lineage_from_rollout, load_rollout_summary,
        rollout_in_progress,
    };
    use serde_json::json;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use tokio::runtime::Runtime;
    use uuid::Uuid;

    fn tmpfile(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ailoom_codex_summary_test_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn derive_lineage_matches_original_logic() {
        let p = tmpfile("lineage.jsonl");
        let content = r#"
{"type":"session_meta","payload":{"id":"A"}}
{"type":"session_meta","payload":{"id":"B"}}
{"type":"session_meta","payload":{"id":"C"}}
{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}
"#;
        fs::write(&p, content.trim_start()).unwrap();
        let lineage = derive_lineage_from_rollout(&p).expect("lineage");
        assert_eq!(lineage.0, 2);
        assert_eq!(lineage.1.as_deref(), Some("B"));
        assert_eq!(lineage.2.as_deref(), Some("C"));
    }

    #[test]
    fn derive_first_user_message_extracts_text() {
        let p = tmpfile("preview.jsonl");
        let content = r#"
{"type":"session_meta","payload":{"id":"A"}}
{"type":"event_msg","payload":{"type":"user_message","message":" hello world "}}
{"type":"event_msg","payload":{"type":"agent_message","message":"reply"}}
"#;
        fs::write(&p, content.trim_start()).unwrap();
        let preview = derive_first_user_message_from_rollout(&p).expect("preview");
        assert_eq!(preview, "hello world");
    }

    #[test]
    fn rollout_in_progress_detects_shutdown() {
        let p = tmpfile("progress.jsonl");
        let jsonl = vec![
            json!({"type":"event_msg","payload":{"type":"agent_message_delta","text":"a"}})
                .to_string(),
            json!({"type":"event_msg","payload":{"type":"shutdown_complete"}}).to_string(),
        ];
        let mut file = std::fs::File::create(&p).unwrap();
        for line in jsonl {
            writeln!(file, "{line}").unwrap();
        }
        assert_eq!(rollout_in_progress(&p), Some(false));
    }

    #[test]
    fn load_rollout_summary_caches_preview() {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let p = tmpfile("summary.jsonl");
            let content = r#"
{"type":"session_meta","payload":{"id":"root"}}
{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}
"#;
            fs::write(&p, content.trim_start()).unwrap();
            let summary = load_rollout_summary(&p).await.unwrap();
            assert_eq!(summary.preview.as_deref(), Some("hello"));
            assert_eq!(summary.depth, Some(0));
        });
    }
}
