use crate::state::AppState;
use crate::ws::chat_events::{event, ChatEvent, ChatHistoryEntry};
use serde_json::{json, Value};

use super::types::ResumeEventPayload;
use super::{Turn, TurnStepKind};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};

pub fn into_resume_event_payload(tuple: (ChatEvent, Option<usize>)) -> ResumeEventPayload {
    let (chat_event, turn_seq) = tuple;
    let (method, mut params) = event(chat_event);
    if let Some(seq) = turn_seq {
        match &mut params {
            Value::Null => {
                params = json!({"turnSeq": seq});
            }
            Value::Object(map) => {
                map.insert("turnSeq".into(), json!(seq));
            }
            _ => {
                params = json!({"value": params, "turnSeq": seq});
            }
        }
    }
    let params = match params {
        Value::Null => None,
        Value::Object(ref map) if map.is_empty() => None,
        other => Some(other),
    };
    ResumeEventPayload { method, params }
}

/// 与 into_resume_event_payload 类似，但同时附加额外字段（如 ts）到 params 中。
pub fn into_resume_event_payload_with_ts(
    tuple: (ChatEvent, Option<usize>),
    ts: Option<&str>,
) -> ResumeEventPayload {
    let (chat_event, turn_seq) = tuple;
    let (method, mut params) = event(chat_event);
    // merge turnSeq
    if let Some(seq) = turn_seq {
        match &mut params {
            Value::Null => {
                params = json!({"turnSeq": seq});
            }
            Value::Object(map) => {
                map.insert("turnSeq".into(), json!(seq));
            }
            _ => {
                params = json!({"value": params, "turnSeq": seq});
            }
        }
    }
    // merge ts if provided
    if let Some(ts_str) = ts {
        match &mut params {
            Value::Null => {
                params = json!({"ts": ts_str});
            }
            Value::Object(map) => {
                map.insert("ts".into(), json!(ts_str));
            }
            _ => {
                params = json!({"value": params, "ts": ts_str});
            }
        }
    }
    let params = match params {
        Value::Null => None,
        Value::Object(ref map) if map.is_empty() => None,
        other => Some(other),
    };
    ResumeEventPayload { method, params }
}

/// 为 HTTP resume 收敛事件：
/// - 去除流式增量（chat.message.delta / chat.reasoning.delta）
/// - 保留阶段性/终结类与工具类事件（用于步骤快照）
pub fn filter_events_for_http_resume(
    events: &[(ChatEvent, Option<usize>)],
) -> Vec<(ChatEvent, Option<usize>)> {
    use crate::ws::chat_events::ChatEvent as CE;
    events
        .iter()
        .cloned()
        .filter(|(ev, _)| match ev {
            CE::MessageDelta { .. } | CE::ReasoningDelta { .. } => false,
            _ => true,
        })
        .collect()
}

/// 由基准时间生成一串按秒递增的 RFC3339 时间；若基准时间解析失败或缺失，则返回 None 列表。
pub fn build_ts_series(base_ts: Option<&str>, len: usize) -> Vec<Option<String>> {
    if len == 0 {
        return Vec::new();
    }
    let base = match base_ts.and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok()) {
        Some(t) => t,
        None => return vec![None; len],
    };
    (0..len)
        .map(|i| {
            let t = base + Duration::seconds(i as i64);
            t.format(&Rfc3339).ok()
        })
        .collect()
}

pub fn broadcast_resume(state: &AppState, conversation_id: &str, history: &[ChatHistoryEntry]) {
    if let Some(hub) = state.ws_hub.clone() {
        let (m, p) = event(ChatEvent::SessionResumed {
            conversation_id: conversation_id.to_string(),
        });
        hub.broadcast_ephemeral(m, p);
        if !history.is_empty() {
            let (hm, hp) = event(ChatEvent::SessionHistory {
                conversation_id: conversation_id.to_string(),
                messages: history.to_vec(),
            });
            hub.broadcast_ephemeral(hm, hp);
        }
    }
}

fn read_env_usize(key: &str, default_val: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default_val)
}

fn home_dir() -> Option<std::path::PathBuf> {
    if let Ok(h) = std::env::var("HOME") {
        return Some(std::path::PathBuf::from(h));
    }
    if let Ok(h) = std::env::var("USERPROFILE") {
        return Some(std::path::PathBuf::from(h));
    }
    None
}

pub(crate) fn resolve_blob_base_dir(state: &AppState) -> std::path::PathBuf {
    // 1) 显式环境变量覆盖（绝对路径）
    if let Ok(dir) = std::env::var("AILOOM_CHAT_BLOB_DIR") {
        let p = std::path::PathBuf::from(dir);
        if p.is_absolute() {
            return p;
        }
    }
    // 2) 生产默认：~/.ailoom/resume-blobs
    if let Some(home) = home_dir() {
        let p = home.join(".ailoom").join("resume-blobs");
        return p;
    }
    // 3) 回退：工作区 ./.ailoom/resume-blobs
    state.workspace_root.join(".ailoom").join("resume-blobs")
}

fn store_blob(state: &AppState, conversation_id: &str, content: &str) -> Option<String> {
    use std::fs;
    use std::io::Write;
    if content.is_empty() {
        return None;
    }
    let cid_safe = conversation_id.replace('/', "_").replace(':', "_");
    // 先使用生产默认（~/.ailoom），失败则回退到工作区内 .ailoom 目录
    let base_pref = resolve_blob_base_dir(state).join(cid_safe.clone());
    let base_fallback = state
        .workspace_root
        .join(".ailoom")
        .join("resume-blobs")
        .join(cid_safe);
    let base = if std::fs::create_dir_all(&base_pref).is_ok() {
        base_pref
    } else {
        base_fallback
    };
    // 确保目录存在
    let _ = fs::create_dir_all(&base);
    let blob_id = uuid::Uuid::new_v4().to_string();
    let path = base.join(format!("{}.txt", blob_id));
    match fs::File::create(&path) {
        Ok(mut f) => {
            if let Err(e) = f.write_all(content.as_bytes()) {
                tracing::warn!(target:"codex", error=?e, "写入 blob 失败");
                return None;
            }
        }
        Err(e) => {
            tracing::warn!(target:"codex", error=?e, "创建 blob 文件失败");
            return None;
        }
    }
    Some(blob_id)
}

/// 对 turns 进行后处理：
/// - 若 exec/patch 的正文过长，则截断并写入本地 blob 文件，返回 outputBlobId 与 truncated=true
pub fn shrink_turns_and_emit_blobs(state: &AppState, conversation_id: &str, turns: &mut [Turn]) {
    let max_exec = read_env_usize("AILOOM_CHAT_EXEC_BODY_MAX_CHARS", 4000);
    let max_patch = read_env_usize("AILOOM_CHAT_PATCH_BODY_MAX_CHARS", 8000);
    for turn in turns.iter_mut() {
        for step in turn.steps.iter_mut() {
            let limit = match step.kind {
                TurnStepKind::Exec => max_exec,
                TurnStepKind::Patch => max_patch,
                _ => continue,
            };
            let Some(body) = step.body.as_mut() else {
                continue;
            };
            // 使用“字符数”判断与截断，避免多字节字符被按字节边界截断导致 panic
            if body.chars().count() <= limit {
                continue;
            }
            if let Some(blob_id) = store_blob(state, conversation_id, body) {
                // 按字符数安全截断
                let mut head: String = body.chars().take(limit).collect();
                head.push_str("\n... (truncated)");
                *body = head;
                let meta = step
                    .meta
                    .get_or_insert_with(|| Value::Object(serde_json::Map::new()));
                if let Some(obj) = meta.as_object_mut() {
                    obj.insert("truncated".into(), json!(true));
                    obj.insert("outputBlobId".into(), json!(blob_id));
                }
            }
        }
    }
}

/// 将历史与已规整的 ChatEvent 列表归并为 turn-first 结构（用于 HTTP resume 快照）。
pub fn build_turns_from_history_and_events(
    conversation_id: &str,
    history: &[ChatHistoryEntry],
    events: &[(ChatEvent, Option<usize>)],
) -> Vec<Turn> {
    // 基于 history 构建最小 turns（user/reasoning/assistant）
    #[derive(Default)]
    struct TurnOut {
        id: String,
        seq: usize,
        conversation_id: String,
        started_at: Option<String>,
        completed_at: Option<String>,
        status: String,
        user: Option<Value>,
        assistant: Option<Value>,
        reasoning: Option<Value>,
        steps: Vec<Value>,
    }
    fn summarize_first_line(s: &str) -> String {
        let raw = s.replace('\r', "");
        for ln in raw.lines() {
            let t = ln.trim();
            if !t.is_empty() {
                return t.trim_matches(|c: char| " #>*_`\t".contains(c)).to_string();
            }
        }
        String::new()
    }
    fn strip_dup_title(body: &str, title: &str) -> String {
        if title.is_empty() {
            return body.to_string();
        }
        let binding = body.replace('\r', "");
        let lines: Vec<&str> = binding.lines().collect();
        // 找到首个非空行并比较
        let mut idx = None;
        for i in 0..lines.len() {
            if !lines[i].trim().is_empty() {
                idx = Some(i);
                break;
            }
        }
        if let Some(i0) = idx {
            let norm = |s: &str| {
                s.trim_matches(|c: char| " #>*_`\t".contains(c))
                    .trim()
                    .to_string()
            };
            if norm(lines[i0]) == norm(title) {
                // 去掉该行与紧随其后的空行
                let mut out = Vec::new();
                for (i, ln) in lines.iter().enumerate() {
                    if i == i0 {
                        continue;
                    }
                    if i == i0 + 1 && ln.trim().is_empty() {
                        continue;
                    }
                    out.push(*ln);
                }
                return out.join("\n");
            }
        }
        body.to_string()
    }
    fn new_turn(seq: usize, cid: &str, user_text: Option<&str>) -> TurnOut {
        TurnOut {
            id: format!("turn-resume_{}", seq),
            seq,
            conversation_id: cid.to_string(),
            started_at: None,
            completed_at: None,
            status: "streaming".into(),
            user: user_text.map(|t| json!({"text": t})),
            assistant: None,
            reasoning: None,
            steps: Vec::new(),
        }
    }
    let mut turns: Vec<TurnOut> = Vec::new();
    let mut seq = 0usize;
    // history → turns
    for item in history {
        match item.role.as_str() {
            "user" => {
                seq += 1;
                let t = new_turn(seq, conversation_id, Some(&item.text));
                turns.push(t);
            }
            "reasoning" => {
                if turns.is_empty() {
                    seq += 1;
                    turns.push(new_turn(seq, conversation_id, None));
                }
                let t = turns.last_mut().unwrap();
                let mut content = item.reasoning.clone().unwrap_or_default();
                if let Some(obj) = t.reasoning.as_ref() {
                    if let Some(prev) = obj.get("content").and_then(|v| v.as_str()) {
                        if !prev.is_empty() {
                            content = format!("{}\n\n{}", prev, content);
                        }
                    }
                }
                let title = summarize_first_line(&content);
                t.reasoning = Some(json!({"content": content, "title": title}));
            }
            "assistant" => {
                // 若上一个 turn 已经有 assistant，则根据“首条内容隐式开启”的规则开始一个新 turn
                let need_new_turn = if let Some(last) = turns.last() {
                    last.assistant
                        .as_ref()
                        .and_then(|v| v.get("text"))
                        .and_then(|v| v.as_str())
                        .map(|s| !s.is_empty())
                        .unwrap_or(false)
                } else {
                    true
                };
                if turns.is_empty() || need_new_turn {
                    seq += 1;
                    turns.push(new_turn(seq, conversation_id, None));
                }
                let t = turns.last_mut().unwrap();
                t.assistant = Some(json!({"text": item.text}));
                if t.status != "failed" && t.status != "aborted" {
                    t.status = "completed".into();
                }
            }
            _ => {}
        }
    }
    // 事件 → steps/边界
    use crate::ws::chat_events::ChatEvent as CE;
    for (ev, maybe_seq) in events.iter() {
        let idx = if let Some(s) = maybe_seq { *s } else { seq }; // 附加到指定/最后一轮
        let turn = if let Some(pos) = turns.iter().position(|t| t.seq == idx) {
            Some(pos)
        } else if idx > 0 {
            // 事件指向一个尚不存在的 turn 序号：按序号显式补建该 turn
            let new_seq = idx;
            // 确保 seq 记录不回退
            if new_seq > seq {
                seq = new_seq;
            }
            turns.push(new_turn(new_seq, conversation_id, None));
            Some(turns.len() - 1)
        } else {
            // 未指定且当前无 turn：创建第一个 turn
            seq += 1;
            turns.push(new_turn(seq, conversation_id, None));
            Some(turns.len() - 1)
        };
        let Some(pos) = turn else { continue };
        let t = turns.get_mut(pos).unwrap();
        match ev {
            CE::ReasoningEnd { text } => {
                let title = summarize_first_line(text);
                let body = strip_dup_title(text, &title);
                let full_title = if title.is_empty() {
                    "thinking".to_string()
                } else {
                    format!("thinking: {}", title)
                };
                t.steps.push(json!({
                    "id": format!("step-resume-thinking-{}-{}", idx, t.steps.len()+1),
                    "kind": "thinking",
                    "title": full_title,
                    "body": body,
                    "status": "completed"
                }));
            }
            CE::ToolExecBegin {
                cwd,
                command,
                call_id,
            } => {
                t.steps.push(json!({
                    "id": format!("step-resume-exec-{}-{}", idx, t.steps.len()+1),
                    "kind": "exec",
                    "title": if command.is_empty() { "exec".into() } else { command.join(" ") },
                    "status": "streaming",
                    "meta": {"cwd": cwd, "callId": call_id, "command": command}
                }));
            }
            CE::ToolExecOutput {
                call_id,
                stream: _,
                text,
            } => {
                // 追加到最近的 exec/matching callId
                if let Some(last) = t.steps.iter_mut().rev().find(|s| {
                    s.get("kind").and_then(|v| v.as_str()) == Some("exec")
                        && (call_id.is_none()
                            || s.get("meta")
                                .and_then(|m| m.get("callId"))
                                .and_then(|v| v.as_str())
                                == call_id.as_deref())
                }) {
                    let prev = last
                        .get("body")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let joined = if prev.is_empty() {
                        text.clone()
                    } else {
                        format!(
                            "{}{}{}",
                            prev,
                            if prev.ends_with('\n') { "" } else { "\n" },
                            text
                        )
                    };
                    last.as_object_mut()
                        .unwrap()
                        .insert("body".into(), Value::String(joined));
                }
            }
            CE::ToolExecEnd {
                call_id,
                exit_code,
                duration_ms,
                stdout,
                stderr,
            } => {
                if let Some(last) = t.steps.iter_mut().rev().find(|s| {
                    s.get("kind").and_then(|v| v.as_str()) == Some("exec")
                        && (call_id.is_none()
                            || s.get("meta")
                                .and_then(|m| m.get("callId"))
                                .and_then(|v| v.as_str())
                                == call_id.as_deref())
                }) {
                    // 标记完成
                    last.as_object_mut()
                        .unwrap()
                        .insert("status".into(), Value::String("completed".into()));
                    // 合并 meta：在保留 command/cwd/callId 的同时，补充结束信息
                    let mut meta = last.get("meta").cloned().unwrap_or(json!({}));
                    if !meta.is_object() {
                        meta = json!({});
                    }
                    if let Some(obj) = meta.as_object_mut() {
                        if obj.get("callId").is_none() {
                            obj.insert("callId".into(), json!(call_id));
                        }
                        obj.insert("exitCode".into(), json!(exit_code));
                        obj.insert("durationMs".into(), json!(duration_ms));
                        obj.insert("stdout".into(), json!(stdout));
                        obj.insert("stderr".into(), json!(stderr));
                    }
                    last.as_object_mut().unwrap().insert("meta".into(), meta);
                }
            }
            CE::ToolPatchBegin {
                call_id,
                files,
                auto_approved,
                first_path,
                adds,
                dels,
                changes,
            } => {
                let title = first_path.clone().unwrap_or_else(|| "patch".to_string());
                t.steps.push(json!({
                    "id": format!("step-resume-patch-{}-{}", idx, t.steps.len()+1),
                    "kind": "patch",
                    "title": title,
                    "status": "streaming",
                    "meta": {"callId": call_id, "patch": {"files": files, "adds": adds, "dels": dels, "firstPath": first_path}, "autoApproved": auto_approved, "changes": changes}
                }));
            }
            CE::ToolPatchEnd {
                call_id,
                success,
                stdout,
                stderr,
            } => {
                if let Some(last) = t.steps.iter_mut().rev().find(|s| {
                    s.get("kind").and_then(|v| v.as_str()) == Some("patch")
                        && (call_id.is_none()
                            || s.get("meta")
                                .and_then(|m| m.get("callId"))
                                .and_then(|v| v.as_str())
                                == call_id.as_deref())
                }) {
                    let status = if *success { "completed" } else { "failed" };
                    last.as_object_mut()
                        .unwrap()
                        .insert("status".into(), Value::String(status.into()));
                    let mut meta = last.get("meta").cloned().unwrap_or(json!({}));
                    if let Some(obj) = meta.as_object_mut() {
                        obj.insert("success".into(), json!(success));
                        obj.insert("stdout".into(), json!(stdout));
                        obj.insert("stderr".into(), json!(stderr));
                    }
                    last.as_object_mut().unwrap().insert("meta".into(), meta);
                }
            }
            CE::ToolMcpBegin {
                call_id,
                server,
                tool,
                arguments,
            } => {
                t.steps.push(json!({
                    "id": format!("step-resume-mcp-{}-{}", idx, t.steps.len()+1),
                    "kind": "mcp",
                    "title": format!("{}:{}", server, tool),
                    "status": "streaming",
                    // 对齐前端：参数命名使用 args，同时保留 arguments 以兼容
                    "meta": {"callId": call_id, "server": server, "tool": tool, "args": arguments, "arguments": arguments}
                }));
            }
            CE::ToolMcpEnd {
                call_id,
                server,
                tool,
                arguments,
                result,
            } => {
                if let Some(last) = t.steps.iter_mut().rev().find(|s| {
                    s.get("kind").and_then(|v| v.as_str()) == Some("mcp")
                        && s.get("meta")
                            .and_then(|m| m.get("callId"))
                            .and_then(|v| v.as_str())
                            == Some(call_id.as_str())
                }) {
                    last.as_object_mut()
                        .unwrap()
                        .insert("status".into(), Value::String("completed".into()));
                    let mut meta = last.get("meta").cloned().unwrap_or(json!({}));
                    if !meta.is_object() {
                        meta = json!({});
                    }
                    if let Some(obj) = meta.as_object_mut() {
                        obj.insert("callId".into(), json!(call_id));
                        obj.insert("server".into(), json!(server));
                        obj.insert("tool".into(), json!(tool));
                        // 对齐前端：args 字段
                        obj.insert("args".into(), json!(arguments));
                        // 兼容
                        obj.insert("arguments".into(), json!(arguments));
                        obj.insert("result".into(), json!(result));
                    }
                    last.as_object_mut().unwrap().insert("meta".into(), meta);
                }
            }
            CE::InfoPlanUpdate { explanation, plan } => {
                t.steps.push(json!({
                    "id": format!("step-resume-plan-{}-{}", idx, t.steps.len()+1),
                    "kind": "plan",
                    "title": explanation.as_ref().map(|s| format!("Plan 更新：{}", s)).unwrap_or_else(|| "Plan 更新".into()),
                    "status": "completed",
                    "meta": {"plan": plan}
                }));
            }
            CE::InfoTurnDiff { diff } => {
                t.steps.push(json!({
                    "id": format!("step-resume-info-{}-{}", idx, t.steps.len()+1),
                    "kind": "info",
                    "title": format!("Turn diff 更新:\n\n```diff\n{}\n```", diff),
                    "status": "completed"
                }));
            }
            CE::MessageCompleted { text } => {
                if let Some(txt) = text.as_ref() {
                    // 避免覆盖基于 history 已确定的最终助手文本：
                    // 仅当尚无助手文本（或为空）时，才用事件填充。
                    let should_set = match t.assistant.as_ref() {
                        None => true,
                        Some(val) => val
                            .get("text")
                            .and_then(|v| v.as_str())
                            .map(|s| s.is_empty())
                            .unwrap_or(true),
                    };
                    if should_set {
                        t.assistant = Some(json!({"text": txt}));
                    }
                    if t.status != "failed" && t.status != "aborted" {
                        t.status = "completed".into();
                    }
                }
            }
            CE::MessageFailed { error } => {
                t.assistant = Some(json!({"text": error.message}));
                t.status = "failed".into();
            }
            CE::MessageAborted => {
                t.status = "aborted".into();
            }
            CE::TurnComplete => {
                if t.status != "failed" && t.status != "aborted" {
                    t.status = "completed".into();
                }
            }
            _ => {}
        }
    }

    // 序列化输出
    turns
        .into_iter()
        .map(|t| {
            let user_val = t.user.unwrap_or_else(|| json!({ "text": "", "ts": null }));
            let assistant_val = t
                .assistant
                .unwrap_or_else(|| json!({ "text": "", "ts": null }));
            let value = json!({
                "id": t.id,
                "seq": t.seq as u32,
                "conversationId": t.conversation_id,
                "startedAt": t.started_at,
                "completedAt": t.completed_at,
                "status": t.status,
                "user": user_val,
                "assistant": assistant_val,
                "reasoning": t.reasoning,
                "steps": t.steps,
            });
            serde_json::from_value::<Turn>(value).expect("serialize turn")
        })
        .collect()
}
