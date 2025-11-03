use crate::ws::chat_events::ChatEvent;
use ailoom_executors::providers::codex::{ReasoningOutput, ReasoningTracker};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

use super::types::FunctionCallOutputEnvelope;

#[derive(Default)]
pub struct EventAccumulator {
    pub events: Vec<(ChatEvent, Option<usize>)>,
    pub exec_calls: HashSet<String>,
    pub mcp_calls: HashMap<String, (String, String, Option<Value>)>,
    pub patch_calls: HashSet<String>,
    pub current_turn_seq: usize,
    pub turn_open: bool,
    pub reasoning_tracker: ReasoningTracker,
    pub last_reasoning_seq: Option<usize>,
}

#[derive(Default, Clone)]
struct ApplyPatchInvocationMeta {
    files: Option<usize>,
    first_path: Option<String>,
    adds: Option<usize>,
    dels: Option<usize>,
    changes: Option<Value>,
    patch_text: Option<String>,
}

impl ApplyPatchInvocationMeta {
    fn ensure_from_patch_text(&mut self, patch: &str) {
        if patch.trim().is_empty() {
            return;
        }
        match self.patch_text {
            Some(ref mut existing) => {
                if !existing.contains(patch) {
                    existing.push_str("\n");
                    existing.push_str(patch);
                }
            }
            None => {
                self.patch_text = Some(patch.to_string());
            }
        }
        if let Some(summary) = summarize_patch_text(patch) {
            if self.first_path.is_none() {
                self.first_path = summary.first_path.clone();
            }
            if self.files.is_none() && summary.files > 0 {
                self.files = Some(summary.files);
            }
            if self.adds.is_none() && summary.adds > 0 {
                self.adds = Some(summary.adds);
            }
            if self.dels.is_none() && summary.dels > 0 {
                self.dels = Some(summary.dels);
            }
        }
    }

    fn files(&self) -> usize {
        if let Some(f) = self.files {
            return f;
        }
        if let Some(ref changes) = self.changes {
            if let Some(obj) = changes.as_object() {
                if !obj.is_empty() {
                    return obj.len();
                }
            }
        }
        if self
            .patch_text
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            return 1;
        }
        0
    }

    fn changes(&mut self) -> Option<Value> {
        if self.changes.is_some() {
            return self.changes.clone();
        }
        if let Some(ref patch) = self.patch_text {
            let key = self
                .first_path
                .clone()
                .unwrap_or_else(|| "apply_patch.diff".into());
            self.changes = build_changes_from_patch(&key, patch);
        }
        self.changes.clone()
    }
}

impl EventAccumulator {
    fn emit_reasoning_outputs(&mut self, outputs: Vec<ReasoningOutput>) {
        if outputs.is_empty() {
            return;
        }
        let seq = self.resolve_reasoning_seq();
        self.last_reasoning_seq = Some(seq);
        for output in outputs {
            match output {
                ReasoningOutput::ContentDelta {
                    delta,
                    item_id,
                    source,
                } => {
                    let ev = ChatEvent::ReasoningDelta {
                        delta,
                        item_id,
                        source,
                    };
                    self.events.push((ev, Some(seq)));
                }
                ReasoningOutput::RawDelta { delta, item_id } => {
                    let ev = ChatEvent::ReasoningRawDelta { delta, item_id };
                    self.events.push((ev, Some(seq)));
                }
                ReasoningOutput::ItemStarted { item_id } => {
                    let ev = ChatEvent::ReasoningItemStarted { item_id };
                    self.events.push((ev, Some(seq)));
                }
                ReasoningOutput::ItemCompleted { item_id } => {
                    let ev = ChatEvent::ReasoningItemCompleted { item_id };
                    self.events.push((ev, Some(seq)));
                }
                ReasoningOutput::FinalSummary {
                    item_id,
                    text,
                    raw_content,
                } => {
                    let ev = ChatEvent::ReasoningEnd {
                        text,
                        item_id,
                        raw_content,
                    };
                    self.events.push((ev, Some(seq)));
                }
                ReasoningOutput::SectionBreak { .. } => {
                    // resume 渲染不回放 section_break，忽略
                }
            }
        }
    }

    fn flush_reasoning(&mut self) {
        let outputs = self.reasoning_tracker.flush();
        self.emit_reasoning_outputs(outputs);
    }

    fn handle_reasoning_event(&mut self, kind: &str, msg: &Map<String, Value>) {
        let outputs = self.reasoning_tracker.handle_event(kind, msg);
        self.emit_reasoning_outputs(outputs);
    }

    fn resolve_reasoning_seq(&mut self) -> usize {
        if self.turn_open {
            if self.current_turn_seq == 0 {
                self.current_turn_seq = 1;
                self.events
                    .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
            }
            return self.current_turn_seq;
        }
        if self.current_turn_seq > 0 {
            return self.current_turn_seq;
        }
        self.current_turn_seq = 1;
        self.turn_open = true;
        self.events
            .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
        self.current_turn_seq
    }

    pub fn handle_value(&mut self, value: &Value) {
        let Some(kind) = value.get("type").and_then(|v| v.as_str()) else {
            return;
        };
        if kind == "response_item" {
            if let Some(payload) = value.get("payload") {
                self.handle_response_item(payload);
            }
        } else if kind == "event_msg" {
            if let Some(payload) = value.get("payload") {
                self.handle_event_msg(payload);
            }
        }
    }

    fn handle_response_item(&mut self, payload: &Value) {
        let Some(kind) = payload.get("type").and_then(|v| v.as_str()) else {
            return;
        };
        match kind {
            // 根据最新约定：resume 不使用 response_item.reasoning.summary（不参与渲染），直接忽略，减小传输量
            "reasoning" => {}
            "function_call" => {
                let Some(name) = payload.get("name").and_then(|v| v.as_str()) else {
                    return;
                };
                let Some(call_id) = payload.get("call_id").and_then(|v| v.as_str()) else {
                    return;
                };
                let args_val = payload
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                    .unwrap_or(Value::Null);
                // Special-case: update_plan 是一个“信息类”函数调用，不应开启新 turn，归并为 chat.info.plan_update
                if name == "update_plan" {
                    let explanation = args_val
                        .get("explanation")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let plan = args_val
                        .get("plan")
                        .cloned()
                        .unwrap_or_else(|| Value::Array(vec![]));
                    let ev = ChatEvent::InfoPlanUpdate { explanation, plan };
                    let seq = if self.current_turn_seq > 0 {
                        Some(self.current_turn_seq)
                    } else {
                        None
                    };
                    self.events.push((ev, seq));
                    return;
                }
                if name == "shell" {
                    let command = args_val
                        .get("command")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let cwd = args_val
                        .get("cwd")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    self.exec_calls.insert(call_id.to_string());
                    if !self.turn_open {
                        self.current_turn_seq += 1;
                        self.turn_open = true;
                        self.events
                            .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                    }
                    let ev = ChatEvent::ToolExecBegin {
                        cwd,
                        command,
                        call_id: Some(call_id.to_string()),
                    };
                    self.events.push((
                        ev,
                        if self.current_turn_seq > 0 {
                            Some(self.current_turn_seq)
                        } else {
                            None
                        },
                    ));
                } else {
                    // Prefer new naming: <server>__<tool>
                    fn parse_mcp_name(name: &str, args_val: &Value) -> Option<(String, String)> {
                        // 1) Preferred: server__tool
                        if let Some((sv, tl)) = name.split_once("__") {
                            if !sv.is_empty() && !tl.is_empty() {
                                return Some((sv.to_string(), tl.to_string()));
                            }
                        }
                        // 2) From arguments
                        let server = args_val
                            .get("server")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let tool = args_val
                            .get("tool")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        if let (Some(sv), Some(tl)) = (server, tool) {
                            if !sv.is_empty() && !tl.is_empty() {
                                return Some((sv, tl));
                            }
                        }
                        // 3) Backward compat: mcp__server__tool
                        if let Some(rest) = name.strip_prefix("mcp__") {
                            let parts: Vec<&str> = rest.split("__").collect();
                            if parts.len() >= 2 {
                                let sv = parts[0].to_string();
                                let tl = parts[1].to_string();
                                if !sv.is_empty() && !tl.is_empty() {
                                    return Some((sv, tl));
                                }
                            }
                        }
                        // 4) Backward compat: mcp:server/tool
                        if let Some(rest) = name.strip_prefix("mcp:") {
                            if let Some((sv, tl)) = rest.split_once('/') {
                                if !sv.is_empty() && !tl.is_empty() {
                                    return Some((sv.to_string(), tl.to_string()));
                                }
                            }
                        }
                        // 5) Fallback: any server/tool separated by '/'
                        if let Some((sv, tl)) = name.split_once('/') {
                            if !sv.is_empty() && !tl.is_empty() {
                                return Some((sv.to_string(), tl.to_string()));
                            }
                        }
                        None
                    }

                    if let Some((server, tool)) = parse_mcp_name(name, &args_val) {
                        let arguments = Some(args_val.clone());
                        self.mcp_calls.insert(
                            call_id.to_string(),
                            (server.clone(), tool.clone(), arguments.clone()),
                        );
                        if !self.turn_open {
                            self.current_turn_seq += 1;
                            self.turn_open = true;
                            self.events
                                .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                        }
                        let ev = ChatEvent::ToolMcpBegin {
                            call_id: call_id.to_string(),
                            server,
                            tool,
                            arguments,
                        };
                        self.events.push((
                            ev,
                            if self.current_turn_seq > 0 {
                                Some(self.current_turn_seq)
                            } else {
                                None
                            },
                        ));
                    }
                }
            }
            "function_call_output" => {
                let Some(call_id) = payload.get("call_id").and_then(|v| v.as_str()) else {
                    return;
                };
                let raw_output = payload.get("output").and_then(|v| v.as_str()).unwrap_or("");
                let parsed = serde_json::from_str::<FunctionCallOutputEnvelope>(raw_output)
                    .unwrap_or(FunctionCallOutputEnvelope {
                        output: raw_output.to_string(),
                        metadata: None,
                    });
                let text = parsed.output.clone();
                if self.exec_calls.contains(call_id) {
                    if !text.is_empty() {
                        if !self.turn_open {
                            self.current_turn_seq += 1;
                            self.turn_open = true;
                            self.events
                                .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                        }
                        let ev = ChatEvent::ToolExecOutput {
                            call_id: Some(call_id.to_string()),
                            stream: "stdout".into(),
                            text,
                        };
                        self.events.push((
                            ev,
                            if self.current_turn_seq > 0 {
                                Some(self.current_turn_seq)
                            } else {
                                None
                            },
                        ));
                    }
                    if let Some(meta) = parsed.metadata {
                        if !self.turn_open {
                            self.current_turn_seq += 1;
                            self.turn_open = true;
                            self.events
                                .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                        }
                        let duration_ms = meta
                            .duration_seconds
                            .map(|secs| (secs * 1000.0).round() as u64);
                        let ev = ChatEvent::ToolExecEnd {
                            call_id: Some(call_id.to_string()),
                            exit_code: meta.exit_code,
                            duration_ms,
                            stdout: meta.stdout,
                            stderr: meta.stderr,
                        };
                        self.events.push((
                            ev,
                            if self.current_turn_seq > 0 {
                                Some(self.current_turn_seq)
                            } else {
                                None
                            },
                        ));
                        self.exec_calls.remove(call_id);
                    }
                } else if let Some((server, tool, arguments)) = self.mcp_calls.get(call_id).cloned()
                {
                    let result_val: Value = match serde_json::from_str::<Value>(&parsed.output) {
                        Ok(v) => v,
                        Err(_) => Value::String(parsed.output),
                    };
                    if !self.turn_open {
                        self.current_turn_seq += 1;
                        self.turn_open = true;
                        self.events
                            .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                    }
                    let ev = ChatEvent::ToolMcpEnd {
                        call_id: call_id.to_string(),
                        server,
                        tool,
                        arguments,
                        result: result_val,
                    };
                    self.events.push((
                        ev,
                        if self.current_turn_seq > 0 {
                            Some(self.current_turn_seq)
                        } else {
                            None
                        },
                    ));
                    self.mcp_calls.remove(call_id);
                }
            }
            "custom_tool_call" => {
                if let Some(name) = payload.get("name").and_then(|v| v.as_str()) {
                    if name.eq_ignore_ascii_case("apply_patch") {
                        self.handle_apply_patch_custom_tool(payload);
                    }
                }
            }
            _ => {}
        }
    }

    pub fn finish(mut self) -> Vec<(ChatEvent, Option<usize>)> {
        self.flush_reasoning();
        for call_id in self.exec_calls.drain() {
            let ev = ChatEvent::ToolExecEnd {
                call_id: Some(call_id),
                exit_code: None,
                duration_ms: None,
                stdout: None,
                stderr: None,
            };
            self.events.push((
                ev,
                if self.current_turn_seq > 0 {
                    Some(self.current_turn_seq)
                } else {
                    None
                },
            ));
        }
        for (call_id, (server, tool, arguments)) in self.mcp_calls.drain() {
            let ev = ChatEvent::ToolMcpEnd {
                call_id,
                server,
                tool,
                arguments,
                result: Value::Null,
            };
            self.events.push((
                ev,
                if self.current_turn_seq > 0 {
                    Some(self.current_turn_seq)
                } else {
                    None
                },
            ));
        }
        self.events
    }

    fn handle_event_msg(&mut self, payload: &Value) {
        let Some(kind) = payload.get("type").and_then(|v| v.as_str()) else {
            return;
        };
        match kind {
            "turn.started" | "task_started" => {
                if !self.turn_open {
                    self.current_turn_seq += 1;
                    self.turn_open = true;
                }
                let seq = if self.current_turn_seq == 0 {
                    1
                } else {
                    self.current_turn_seq
                };
                self.events.push((ChatEvent::TurnStarted, Some(seq)));
            }
            "user_message" => {
                self.current_turn_seq += 1;
                self.turn_open = true;
                self.events
                    .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                if let Some(text) = payload.get("message").and_then(|v| v.as_str()) {
                    let ev = ChatEvent::InfoUserMessage {
                        text: text.to_string(),
                        kind: None,
                    };
                    self.events.push((ev, Some(self.current_turn_seq)));
                }
            }
            "reasoning_content_delta"
            | "reasoning.content.delta"
            | "reasoning_raw_content_delta"
            | "reasoning.raw_content.delta"
            | "item_started"
            | "reasoning_item_started"
            | "item_completed"
            | "reasoning_item_completed"
            | "agent_reasoning_delta"
            | "agent_reasoning_raw_content"
            | "agent_reasoning"
            | "agent_reasoning_section_break" => {
                if let Some(obj) = payload.as_object() {
                    self.handle_reasoning_event(kind, obj);
                }
            }
            "agent_message_delta" => {
                if let Some(delta) = payload.get("delta").and_then(|v| v.as_str()) {
                    if !self.turn_open {
                        self.current_turn_seq += 1;
                        self.turn_open = true;
                        self.events
                            .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                    }
                    let ev = ChatEvent::MessageDelta {
                        delta: delta.to_string(),
                    };
                    self.events.push((
                        ev,
                        if self.current_turn_seq > 0 {
                            Some(self.current_turn_seq)
                        } else {
                            None
                        },
                    ));
                }
            }
            "agent_message" => {
                if let Some(text) = payload.get("message").and_then(|v| v.as_str()) {
                    // 不再在 agent_message 前合并/落地 pending reasoning，按过程事件各自已落地

                    if !self.turn_open {
                        self.current_turn_seq += 1;
                        self.turn_open = true;
                        self.events
                            .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                    }
                    let ev = ChatEvent::MessageCompleted {
                        text: Some(text.to_string()),
                    };
                    self.events.push((
                        ev,
                        if self.current_turn_seq > 0 {
                            Some(self.current_turn_seq)
                        } else {
                            None
                        },
                    ));
                    self.turn_open = false;
                }
            }
            "exec_command_begin" => {
                let command = payload
                    .get("command")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let cwd = payload
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let call_id = payload
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if let Some(ref cid) = call_id {
                    self.exec_calls.insert(cid.clone());
                }
                if !self.turn_open {
                    self.current_turn_seq += 1;
                    self.turn_open = true;
                    self.events
                        .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                }
                let ev = ChatEvent::ToolExecBegin {
                    cwd,
                    command,
                    call_id,
                };
                self.events.push((
                    ev,
                    if self.current_turn_seq > 0 {
                        Some(self.current_turn_seq)
                    } else {
                        None
                    },
                ));
            }
            "exec_command_output_delta" => {
                let call_id = payload
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let text = payload
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if let (Some(cid), Some(t)) = (call_id, text) {
                    if !self.exec_calls.contains(&cid) {
                        if !self.turn_open {
                            self.current_turn_seq += 1;
                            self.turn_open = true;
                            self.events
                                .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                        }
                        let ev_b = ChatEvent::ToolExecBegin {
                            cwd: None,
                            command: vec![],
                            call_id: Some(cid.clone()),
                        };
                        self.events.push((
                            ev_b,
                            if self.current_turn_seq > 0 {
                                Some(self.current_turn_seq)
                            } else {
                                None
                            },
                        ));
                        self.exec_calls.insert(cid.clone());
                    }
                    if !self.turn_open {
                        self.current_turn_seq += 1;
                        self.turn_open = true;
                        self.events
                            .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                    }
                    let ev = ChatEvent::ToolExecOutput {
                        call_id: Some(cid),
                        stream: "stdout".into(),
                        text: t,
                    };
                    self.events.push((
                        ev,
                        if self.current_turn_seq > 0 {
                            Some(self.current_turn_seq)
                        } else {
                            None
                        },
                    ));
                }
            }
            "exec_command_end" => {
                let call_id = payload
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let exit_code = payload.get("exit_code").and_then(|v| v.as_i64());
                let duration_ms = payload.get("duration").and_then(|v| v.as_u64());
                let stdout = payload
                    .get("stdout")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let stderr = payload
                    .get("stderr")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if let Some(ref cid) = call_id {
                    self.exec_calls.remove(cid);
                }
                if !self.turn_open {
                    self.current_turn_seq += 1;
                    self.turn_open = true;
                    self.events
                        .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                }
                let ev = ChatEvent::ToolExecEnd {
                    call_id,
                    exit_code,
                    duration_ms,
                    stdout,
                    stderr,
                };
                self.events.push((
                    ev,
                    if self.current_turn_seq > 0 {
                        Some(self.current_turn_seq)
                    } else {
                        None
                    },
                ));
            }
            "patch_apply_begin" => {
                let call_id = payload
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if let Some(ref cid) = call_id {
                    if self.patch_calls.contains(cid) {
                        self.update_existing_patch_begin(
                            cid,
                            payload.get("changes").cloned(),
                            payload
                                .get("adds")
                                .and_then(|v| v.as_u64())
                                .map(|n| n as usize),
                            payload
                                .get("dels")
                                .and_then(|v| v.as_u64())
                                .map(|n| n as usize),
                            payload
                                .get("auto_approved")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                        );
                        return;
                    } else {
                        self.patch_calls.insert(cid.clone());
                    }
                }
                let changes = payload.get("changes").cloned();
                let files = changes
                    .as_ref()
                    .and_then(|v| v.as_object())
                    .map(|m| m.len())
                    .unwrap_or(0);
                let first_path = changes
                    .as_ref()
                    .and_then(|v| v.as_object())
                    .and_then(|m| m.keys().next().cloned());
                let auto_approved = payload
                    .get("auto_approved")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let adds = payload
                    .get("adds")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize);
                let dels = payload
                    .get("dels")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize);
                if !self.turn_open {
                    self.current_turn_seq += 1;
                    self.turn_open = true;
                    self.events
                        .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                }
                let ev = ChatEvent::ToolPatchBegin {
                    call_id,
                    files,
                    auto_approved,
                    first_path,
                    adds,
                    dels,
                    changes,
                };
                self.events.push((
                    ev,
                    if self.current_turn_seq > 0 {
                        Some(self.current_turn_seq)
                    } else {
                        None
                    },
                ));
            }
            "patch_apply_end" => {
                let call_id = payload
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let success = payload
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let stdout = payload
                    .get("stdout")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let stderr = payload
                    .get("stderr")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if let Some(ref cid) = call_id {
                    if self.patch_calls.contains(cid) {
                        if self.update_existing_patch_end(
                            cid,
                            success,
                            stdout.clone(),
                            stderr.clone(),
                        ) {
                            return;
                        }
                    } else {
                        self.patch_calls.insert(cid.clone());
                    }
                }
                if !self.turn_open {
                    self.current_turn_seq += 1;
                    self.turn_open = true;
                    self.events
                        .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                }
                let ev = ChatEvent::ToolPatchEnd {
                    call_id,
                    success,
                    stdout,
                    stderr,
                };
                self.events.push((
                    ev,
                    if self.current_turn_seq > 0 {
                        Some(self.current_turn_seq)
                    } else {
                        None
                    },
                ));
            }
            "mcp_tool_call_begin" => {
                let call_id = payload
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let invocation = payload.get("invocation").and_then(|v| v.as_object());
                let server = invocation
                    .and_then(|m| m.get("server"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let tool = invocation
                    .and_then(|m| m.get("tool"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let arguments = invocation.and_then(|m| m.get("arguments")).cloned();
                if !self.turn_open {
                    self.current_turn_seq += 1;
                    self.turn_open = true;
                    self.events
                        .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                }
                let ev = ChatEvent::ToolMcpBegin {
                    call_id,
                    server,
                    tool,
                    arguments,
                };
                self.events.push((
                    ev,
                    if self.current_turn_seq > 0 {
                        Some(self.current_turn_seq)
                    } else {
                        None
                    },
                ));
            }
            "mcp_tool_call_end" => {
                let call_id = payload
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let invocation = payload.get("invocation").and_then(|v| v.as_object());
                let server = invocation
                    .and_then(|m| m.get("server"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let tool = invocation
                    .and_then(|m| m.get("tool"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let arguments = invocation.and_then(|m| m.get("arguments")).cloned();
                let result = payload
                    .get("result")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                if !self.turn_open {
                    self.current_turn_seq += 1;
                    self.turn_open = true;
                    self.events
                        .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                }
                let ev = ChatEvent::ToolMcpEnd {
                    call_id,
                    server,
                    tool,
                    arguments,
                    result,
                };
                self.events.push((
                    ev,
                    if self.current_turn_seq > 0 {
                        Some(self.current_turn_seq)
                    } else {
                        None
                    },
                ));
            }
            // 仅作为信息附加到当前/上一轮，不强制开启新 turn；若当前已有轮，则写入当前 turnSeq
            "turn_diff" => {
                let diff = payload
                    .get("unified_diff")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if diff.is_empty() {
                    return;
                }
                let ev = ChatEvent::InfoTurnDiff { diff };
                let seq = if self.current_turn_seq > 0 {
                    Some(self.current_turn_seq)
                } else {
                    None
                };
                self.events.push((ev, seq));
            }
            // 仅作为信息附加到当前/上一轮，不强制开启新 turn；若当前已有轮，则写入当前 turnSeq
            "plan_update" => {
                let explanation = payload
                    .get("explanation")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let plan = payload
                    .get("plan")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(vec![]));
                let ev = ChatEvent::InfoPlanUpdate { explanation, plan };
                let seq = if self.current_turn_seq > 0 {
                    Some(self.current_turn_seq)
                } else {
                    None
                };
                self.events.push((ev, seq));
            }
            "turn.completed" | "task_complete" => {
                let ev = ChatEvent::TurnComplete;
                self.events.push((
                    ev,
                    if self.current_turn_seq > 0 {
                        Some(self.current_turn_seq)
                    } else {
                        None
                    },
                ));
                self.turn_open = false;
            }
            "turn_failed" => {
                let message = payload
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("turn failed")
                    .to_string();
                let ev = ChatEvent::MessageFailed {
                    error: crate::ws::chat_events::ChatError { message },
                };
                self.events.push((
                    ev,
                    if self.current_turn_seq > 0 {
                        Some(self.current_turn_seq)
                    } else {
                        None
                    },
                ));
                self.events
                    .push((ChatEvent::TurnComplete, Some(self.current_turn_seq.max(1))));
                self.turn_open = false;
            }
            "turn_aborted" => {
                self.events.push((
                    ChatEvent::MessageAborted,
                    if self.current_turn_seq > 0 {
                        Some(self.current_turn_seq)
                    } else {
                        None
                    },
                ));
                self.events
                    .push((ChatEvent::TurnComplete, Some(self.current_turn_seq.max(1))));
                self.turn_open = false;
            }
            _ => {}
        }
    }

    fn handle_apply_patch_custom_tool(&mut self, payload: &Value) {
        let call_id = payload
            .get("call_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(ref cid) = call_id {
            self.patch_calls.insert(cid.clone());
        }

        if !self.turn_open {
            self.current_turn_seq += 1;
            self.turn_open = true;
            let seq = if self.current_turn_seq == 0 {
                1
            } else {
                self.current_turn_seq
            };
            self.events.push((ChatEvent::TurnStarted, Some(seq)));
        }

        let mut meta = parse_apply_patch_invocation(payload.get("input"));

        // 顶层兜底：若 input 未提供 adds/dels/files 等字段，再尝试从 payload 读取
        if meta.files.is_none() {
            if let Some(files) = payload
                .get("input")
                .and_then(|v| v.get("files"))
                .and_then(|v| v.as_u64())
            {
                if files > 0 {
                    meta.files = Some(files as usize);
                }
            }
        }
        if meta.adds.is_none() {
            if let Some(adds) = payload
                .get("input")
                .and_then(|v| v.get("adds"))
                .and_then(|v| v.as_u64())
            {
                if adds > 0 {
                    meta.adds = Some(adds as usize);
                }
            }
        }
        if meta.dels.is_none() {
            if let Some(dels) = payload
                .get("input")
                .and_then(|v| v.get("dels"))
                .and_then(|v| v.as_u64())
            {
                if dels > 0 {
                    meta.dels = Some(dels as usize);
                }
            }
        }
        if meta.first_path.is_none() {
            if let Some(path) = payload
                .get("input")
                .and_then(|v| v.get("firstPath").or_else(|| v.get("first_path")))
                .and_then(|v| v.as_str())
            {
                meta.first_path = Some(path.to_string());
            }
        }

        let files = meta.files();
        let adds = meta.adds;
        let dels = meta.dels;
        let first_path = meta.first_path.clone();
        let changes = meta.changes();
        let auto_approved = payload
            .get("auto_approved")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let turn_seq = if self.current_turn_seq > 0 {
            Some(self.current_turn_seq)
        } else {
            None
        };

        let begin_event = ChatEvent::ToolPatchBegin {
            call_id: call_id.clone(),
            files,
            auto_approved,
            first_path,
            adds,
            dels,
            changes,
        };
        self.events.push((begin_event, turn_seq));

        let status = payload
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("completed")
            .to_ascii_lowercase();
        let mut success = matches!(
            status.as_str(),
            "completed" | "succeeded" | "success" | "ok" | "finished"
        );
        if matches!(
            status.as_str(),
            "failed" | "error" | "cancelled" | "canceled" | "aborted"
        ) {
            success = false;
        }
        if payload.get("error").is_some() {
            success = false;
        }

        let stdout = payload.get("output").map(|v| stringify_json_value(v));
        let stderr = payload
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                if !success {
                    payload
                        .get("message")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            });

        let end_event = ChatEvent::ToolPatchEnd {
            call_id,
            success,
            stdout,
            stderr,
        };
        self.events.push((end_event, turn_seq));
    }

    fn update_existing_patch_begin(
        &mut self,
        call_id: &str,
        changes: Option<Value>,
        adds: Option<usize>,
        dels: Option<usize>,
        auto_approved: bool,
    ) {
        for (event, _) in self.events.iter_mut().rev() {
            if let ChatEvent::ToolPatchBegin {
                call_id: existing_call,
                files,
                auto_approved: existing_auto,
                first_path,
                adds: existing_adds,
                dels: existing_dels,
                changes: existing_changes,
            } = event
            {
                if let Some(existing) = existing_call {
                    if existing == call_id {
                        if let Some(ref ch) = changes {
                            if let Some(obj) = ch.as_object() {
                                if let Some(new_first) = obj.keys().next().cloned() {
                                    if first_path.is_none() {
                                        *first_path = Some(new_first);
                                    }
                                }
                                let count = obj.len();
                                if count > 0 {
                                    *files = count;
                                }
                            }
                            *existing_changes = Some(ch.clone());
                        }
                        if let Some(a) = adds {
                            *existing_adds = Some(a);
                        }
                        if let Some(d) = dels {
                            *existing_dels = Some(d);
                        }
                        *existing_auto = auto_approved;
                        return;
                    }
                }
            }
        }
    }

    fn update_existing_patch_end(
        &mut self,
        call_id: &str,
        success: bool,
        stdout: Option<String>,
        stderr: Option<String>,
    ) -> bool {
        for (event, _) in self.events.iter_mut().rev() {
            if let ChatEvent::ToolPatchEnd {
                call_id: existing_call,
                success: existing_success,
                stdout: existing_stdout,
                stderr: existing_stderr,
            } = event
            {
                if let Some(existing) = existing_call {
                    if existing == call_id {
                        *existing_success = success;
                        if let Some(s) = stdout.clone() {
                            *existing_stdout = Some(s);
                        }
                        if let Some(e) = stderr.clone() {
                            *existing_stderr = Some(e);
                        }
                        return true;
                    }
                }
            }
        }
        false
    }
}

#[derive(Default, Clone)]
struct PatchSummary {
    files: usize,
    first_path: Option<String>,
    adds: usize,
    dels: usize,
}

fn parse_apply_patch_invocation(input: Option<&Value>) -> ApplyPatchInvocationMeta {
    fn absorb(meta: &mut ApplyPatchInvocationMeta, value: &Value) {
        match value {
            Value::Null => {}
            Value::String(s) => meta.ensure_from_patch_text(s),
            Value::Array(arr) => {
                for item in arr {
                    absorb(meta, item);
                }
            }
            Value::Object(map) => {
                if let Some(changes) = map.get("changes") {
                    if changes.as_object().map(|m| !m.is_empty()).unwrap_or(false) {
                        meta.changes = Some(changes.clone());
                        if meta.first_path.is_none() {
                            meta.first_path =
                                changes.as_object().and_then(|m| m.keys().next().cloned());
                        }
                    }
                }
                if let Some(files) = map.get("files").and_then(|v| v.as_u64()) {
                    if files > 0 {
                        meta.files = Some(files as usize);
                    }
                }
                if let Some(adds) = map.get("adds").and_then(|v| v.as_u64()) {
                    if adds > 0 {
                        meta.adds = Some(adds as usize);
                    }
                }
                if let Some(dels) = map.get("dels").and_then(|v| v.as_u64()) {
                    if dels > 0 {
                        meta.dels = Some(dels as usize);
                    }
                }
                if let Some(first) = map
                    .get("firstPath")
                    .or_else(|| map.get("first_path"))
                    .and_then(|v| v.as_str())
                {
                    if meta.first_path.is_none() {
                        meta.first_path = Some(first.to_string());
                    }
                }
                if let Some(patch) = map.get("patch").and_then(|v| v.as_str()) {
                    meta.ensure_from_patch_text(patch);
                }
                if let Some(diff) = map.get("diff").and_then(|v| v.as_str()) {
                    meta.ensure_from_patch_text(diff);
                }
                if let Some(patches) = map.get("patches") {
                    absorb(meta, patches);
                }
            }
            _ => {}
        }
    }

    let mut meta = ApplyPatchInvocationMeta::default();
    if let Some(value) = input {
        absorb(&mut meta, value);
    }
    if meta.changes.is_none() {
        if let Some(ref patch) = meta.patch_text {
            let key = meta
                .first_path
                .clone()
                .unwrap_or_else(|| "apply_patch.diff".into());
            meta.changes = build_changes_from_patch(&key, patch);
        }
    }
    meta
}

fn build_changes_from_patch(path: &str, patch: &str) -> Option<Value> {
    if patch.trim().is_empty() {
        return None;
    }
    let mut update = Map::new();
    update.insert("unified_diff".into(), Value::String(patch.to_string()));
    let mut change = Map::new();
    change.insert("update".into(), Value::Object(update));
    let mut root = Map::new();
    root.insert(path.to_string(), Value::Object(change));
    Some(Value::Object(root))
}

fn summarize_patch_text(patch: &str) -> Option<PatchSummary> {
    let trimmed = patch.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut summary = PatchSummary::default();
    let mut paths = HashSet::new();
    for line in patch.lines() {
        let trimmed_line = line.trim();
        for prefix in ["*** Add File:", "*** Update File:", "*** Delete File:"] {
            if let Some(rest) = trimmed_line.strip_prefix(prefix) {
                let norm = normalize_diff_path(rest.trim());
                if !norm.is_empty() {
                    if summary.first_path.is_none() {
                        summary.first_path = Some(norm.clone());
                    }
                    paths.insert(norm);
                }
            }
        }
        if trimmed_line.starts_with("+++ ") {
            let norm = normalize_diff_path(trimmed_line.trim_start_matches("+++ "));
            if !norm.is_empty() {
                if summary.first_path.is_none() {
                    summary.first_path = Some(norm.clone());
                }
                paths.insert(norm);
            }
        } else if trimmed_line.starts_with("--- ") {
            let norm = normalize_diff_path(trimmed_line.trim_start_matches("--- "));
            if !norm.is_empty() {
                if summary.first_path.is_none() {
                    summary.first_path = Some(norm.clone());
                }
                paths.insert(norm);
            }
        }
        if line.starts_with('+') && !line.starts_with("+++") {
            summary.adds += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            summary.dels += 1;
        }
    }
    if !paths.is_empty() {
        summary.files = paths.len();
    } else if !trimmed.is_empty() {
        summary.files = 1;
    }
    Some(summary)
}

fn normalize_diff_path(raw: &str) -> String {
    let mut trimmed = raw.trim().trim_matches('"').to_string();
    for prefix in ["a/", "b/", "c/"] {
        if trimmed.starts_with(prefix) {
            trimmed = trimmed[prefix.len()..].to_string();
            break;
        }
    }
    trimmed.trim_matches('/').to_string()
}

fn stringify_json_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.to_string(),
        _ => serde_json::to_string(value).unwrap_or_else(|_| String::new()),
    }
}
