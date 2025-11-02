use std::path::PathBuf;

use crate::ws::chat_events::ChatHistoryEntry;
use codex_protocol::config_types::SandboxMode;
use codex_protocol::protocol::{AskForApproval, SessionMetaLine, TurnContextItem};
use serde_json::Value;
use tokio::fs;

use super::event_accumulator::EventAccumulator;
use super::history::convert_history_item;
use super::types::{EnvironmentContextSnapshot, RolloutConfigSnapshot, RolloutParseResult};

fn parse_environment_context(xml: &str) -> EnvironmentContextSnapshot {
    fn extract_tag(xml: &str, tag: &str) -> Option<String> {
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let start = xml.find(&open)? + open.len();
        let end = xml[start..].find(&close)?;
        Some(xml[start..start + end].trim().to_string())
    }
    fn extract_all(xml: &str, tag: &str) -> Vec<String> {
        let mut items = Vec::new();
        let open = format!("<{tag}>");
        let close = format!("</{tag}>");
        let mut search_start = 0;
        while let Some(start_idx) = xml[search_start..].find(&open) {
            let start = search_start + start_idx + open.len();
            if let Some(end_rel) = xml[start..].find(&close) {
                let end = start + end_rel;
                items.push(xml[start..end].trim().to_string());
                search_start = end + close.len();
            } else {
                break;
            }
        }
        items
    }

    let cwd = extract_tag(xml, "cwd").map(PathBuf::from);
    let approval_policy = extract_tag(xml, "approval_policy")
        .and_then(|s| serde_json::from_str::<AskForApproval>(&format!("\"{s}\"")).ok());
    let sandbox_mode = extract_tag(xml, "sandbox_mode")
        .and_then(|s| serde_json::from_str::<SandboxMode>(&format!("\"{s}\"")).ok());
    let network_access = extract_tag(xml, "network_access").and_then(|s| match s.as_str() {
        "enabled" => Some(true),
        "disabled" => Some(false),
        _ => None,
    });
    let writable_roots = extract_all(xml, "root")
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let shell = extract_tag(xml, "shell");

    EnvironmentContextSnapshot {
        cwd,
        approval_policy,
        sandbox_mode,
        network_access,
        writable_roots,
        shell,
    }
}

fn flush_pending_reasoning_to_history(
    summary: &mut Option<String>,
    process_parts: &mut Vec<String>,
    list: &mut Vec<ChatHistoryEntry>,
) {
    if let Some(s) = summary.take() {
        if !s.trim().is_empty() {
            list.push(ChatHistoryEntry {
                role: "reasoning".into(),
                text: String::new(),
                reasoning: Some(s),
            });
        }
        process_parts.clear();
        return;
    }
    if !process_parts.is_empty() {
        let combined = process_parts.join("\n\n");
        if !combined.trim().is_empty() {
            list.push(ChatHistoryEntry {
                role: "reasoning".into(),
                text: String::new(),
                reasoning: Some(combined),
            });
        }
        process_parts.clear();
    }
}

pub fn parse_rollout(content: &str) -> RolloutParseResult {
    let mut history_entries: Vec<ChatHistoryEntry> = Vec::new();
    let mut snapshot = RolloutConfigSnapshot::default();
    let mut accumulator = EventAccumulator::default();

    // 推理汇总（response_item.reasoning.summary）与过程（event_msg.agent_reasoning）
    // 场景：可能先有若干 agent_reasoning（过程），最终出现 reasoning.summary（汇总，覆盖前者）。
    // 策略：优先使用 summary；若未出现 summary，则在该轮 agent_message 之前合并过程文本为一条 reasoning。
    let _pending_reasoning_summary: Option<String> = None;
    let _pending_reasoning_process: Vec<String> = Vec::new();

    // 在插入 assistant 之前，先根据 pending 写入一条 reasoning（若存在），随后清空。

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        accumulator.handle_value(&value);

        let Some(kind) = value.get("type").and_then(|v| v.as_str()) else {
            continue;
        };
        match kind {
            "turn_context" => {
                if let Some(payload) = value.get("payload") {
                    if let Ok(ctx) = serde_json::from_value::<TurnContextItem>(payload.clone()) {
                        let mut snapshot_turn = snapshot.turn.take().unwrap_or_default();
                        snapshot_turn.model = Some(ctx.model);
                        snapshot_turn.approval_policy = Some(ctx.approval_policy);
                        snapshot_turn.sandbox_policy = Some(ctx.sandbox_policy);
                        snapshot_turn.cwd = Some(ctx.cwd);
                        snapshot_turn.effort = ctx.effort.map(|e| e.to_string());
                        snapshot_turn.summary = Some(ctx.summary.to_string());
                        snapshot.turn = Some(snapshot_turn);
                    }
                }
            }
            "session_meta" => {
                if snapshot.session_meta.is_none() {
                    if let Some(payload) = value.get("payload") {
                        if let Ok(meta) = serde_json::from_value::<SessionMetaLine>(payload.clone())
                        {
                            snapshot.session_meta = Some(meta);
                        }
                    }
                }
            }
            "response_item" => {
                if let Some(payload) = value.get("payload") {
                    if let Some(ptyp) = payload.get("type").and_then(|v| v.as_str()) {
                        if ptyp == "turn_context" {
                            if let Ok(ctx) =
                                serde_json::from_value::<TurnContextItem>(payload.clone())
                            {
                                let mut snapshot_turn = snapshot.turn.take().unwrap_or_default();
                                snapshot_turn.model = Some(ctx.model);
                                snapshot_turn.approval_policy = Some(ctx.approval_policy);
                                snapshot_turn.sandbox_policy = Some(ctx.sandbox_policy);
                                snapshot_turn.cwd = Some(ctx.cwd);
                                snapshot_turn.effort = ctx.effort.map(|e| e.to_string());
                                snapshot_turn.summary = Some(ctx.summary.to_string());
                                snapshot.turn = Some(snapshot_turn);
                            }
                        } else if ptyp == "agent_thinking" {
                            if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
                                if text.contains("<environment_context>") {
                                    snapshot.environment = Some(parse_environment_context(text));
                                }
                            }
                        } else if ptyp == "message" {
                            // scan message content for <environment_context> blocks
                            if let Some(content) = payload.get("content").and_then(|v| v.as_array())
                            {
                                let mut last_env: Option<EnvironmentContextSnapshot> = None;
                                for item in content {
                                    if item.get("type").and_then(|v| v.as_str())
                                        == Some("input_text")
                                    {
                                        if let Some(text) =
                                            item.get("text").and_then(|v| v.as_str())
                                        {
                                            if text.contains("<environment_context>") {
                                                last_env = Some(parse_environment_context(text));
                                            }
                                        }
                                    }
                                }
                                if let Some(env) = last_env {
                                    snapshot.environment = Some(env);
                                }
                            }
                        } else if ptyp == "reasoning" {
                            // resume 接口不使用 response_item.reasoning.summary（不参与渲染），忽略
                        }
                    }
                }
            }
            "event_msg" => {
                if let Some(payload) = value.get("payload") {
                    if let Some(ptyp) = payload.get("type").and_then(|v| v.as_str()) {
                        match ptyp {
                            "agent_reasoning" | "agent_message" | "user_message" => {
                                if let Some(entry) = convert_history_item(payload) {
                                    history_entries.push(entry);
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // 结束：不再落地 summary 或合并过程（按事件序归档已完成）

    RolloutParseResult {
        history: history_entries,
        snapshot,
        events: accumulator.finish(),
    }
}

pub async fn load_rollout_snapshot(path: &str) -> Option<RolloutParseResult> {
    match fs::read_to_string(path).await {
        Ok(content) => Some(parse_rollout(&content)),
        Err(err) => {
            tracing::debug!(
                target: "codex",
                path = %path,
                error = %err,
                "读取 Codex rollout 失败，跳过配置恢复"
            );
            None
        }
    }
}

/// 粗略判定某个 rollout JSONL 是否“仍在进行中”。
/// 逻辑：从文件尾部向前扫描，找到最近一条 `event_msg`，根据其 `payload.type` 判断：
/// - 如果为 `shutdown_complete`/`task_complete`/`turn_aborted`/`error`/`stream_error` → 认为已结束。
/// - 其它类型（如 `agent_message_delta`/`agent_reasoning_delta`/`exec_*` 等） → 认为仍在进行。
/// 若无法解析，返回 None（由调用方决定默认值）。
pub fn rollout_in_progress(path: &str) -> Option<bool> {
    use std::io::BufRead;
    // 读取文件末尾若干行，找到最近一条 event_msg
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut lines: Vec<String> = Vec::new();
    for line in reader.lines().flatten() {
        let s = line.trim();
        if !s.is_empty() {
            lines.push(s.to_string());
        }
    }
    use std::collections::HashSet;
    let mut closed_fn_calls: HashSet<String> = HashSet::new();
    let mut closed_exec_calls: HashSet<String> = HashSet::new();
    for raw in lines.iter().rev().take(4096) {
        let s = raw.trim();
        if s.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(s) else {
            continue;
        };
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if kind == "response_item" {
            let Some(payload) = v.get("payload") else {
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
        let Some(payload) = v.get("payload") else {
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
            // 对于明确的增量类事件，直接认为“进行中”，避免依赖文件时间粒度造成的非确定性。
            "agent_message_delta" | "agent_reasoning_delta" => {
                return Some(true);
            }
            _ => {
                // 不是显式结束类事件：再结合文件空闲时长判断
                let threshold_ms: u64 = std::env::var("AILOOM_CODEX_ROLLOUT_IDLE_MS")
                    .ok()
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(8000);
                let idle_ms: u64 = match std::fs::metadata(path).and_then(|m| m.modified()) {
                    Ok(modified) => match std::time::SystemTime::now().duration_since(modified) {
                        Ok(dur) => dur.as_millis() as u64,
                        // 系统时间回退或精度问题：保守地视为超过阈值（避免误报进行中）
                        Err(_) => threshold_ms + 1,
                    },
                    // 无法读取修改时间：保守地视为超过阈值
                    Err(_) => threshold_ms + 1,
                };
                if idle_ms >= threshold_ms {
                    return Some(false);
                }
                return Some(true);
            }
        }
    }
    None
}
