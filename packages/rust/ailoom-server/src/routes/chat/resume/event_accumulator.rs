use crate::ws::chat_events::ChatEvent;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

use super::types::FunctionCallOutputEnvelope;

#[derive(Default)]
pub struct EventAccumulator {
    pub events: Vec<(ChatEvent, Option<usize>)>,
    pub exec_calls: HashSet<String>,
    pub mcp_calls: HashMap<String, (String, String, Option<Value>)>,
    pub current_turn_seq: usize,
    pub turn_open: bool,
}

impl EventAccumulator {
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
            _ => {}
        }
    }

    pub fn finish(mut self) -> Vec<(ChatEvent, Option<usize>)> {
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
            "agent_reasoning_delta" => {
                if let Some(delta) = payload.get("delta").and_then(|v| v.as_str()) {
                    if !self.turn_open {
                        self.current_turn_seq += 1;
                        self.turn_open = true;
                        self.events
                            .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                    }
                    let ev = ChatEvent::ReasoningDelta {
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
            "agent_reasoning" => {
                if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
                    if !self.turn_open {
                        self.current_turn_seq += 1;
                        self.turn_open = true;
                        self.events
                            .push((ChatEvent::TurnStarted, Some(self.current_turn_seq)));
                    }
                    let ev = ChatEvent::ReasoningEnd {
                        text: text.to_string(),
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
}
