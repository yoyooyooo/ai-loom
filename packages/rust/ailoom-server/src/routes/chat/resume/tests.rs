#![cfg(test)]
use super::config::build_resume_config;
use super::history::convert_history_item;
use super::rollout_parser::parse_rollout;
use super::rollout_parser::rollout_in_progress;
use crate::ws::chat_events::{event, ChatEvent};
use codex_protocol::config_types::SandboxMode;
use serde_json::{json, Value};
use std::path::Path;

fn load_fixture(name: &str) -> &'static str {
    match name {
        "workspace_write" => {
            include_str!("../../../../tests/fixtures/rollouts/workspace_write.jsonl")
        }
        "environment_only" => {
            include_str!("../../../../tests/fixtures/rollouts/environment_only.jsonl")
        }
        "danger_full_access" => {
            include_str!("../../../../tests/fixtures/rollouts/danger_full_access.jsonl")
        }
        "no_context" => include_str!("../../../../tests/fixtures/rollouts/no_context.jsonl"),
        "turn_basic" => include_str!("../../../../tests/fixtures/rollouts/turn_basic.jsonl"),
        "consecutive_agent" => {
            include_str!("../../../../tests/fixtures/rollouts/consecutive_agent.jsonl")
        }
        "failed_abort" => include_str!("../../../../tests/fixtures/rollouts/failed_abort.jsonl"),
        _ => unreachable!("unknown fixture {name}"),
    }
}

#[test]
fn convert_user_message_to_history_entry() {
    let value = json!({ "type": "user_message", "message": "hello" });
    let entry = convert_history_item(&value).expect("expected entry");
    assert_eq!(entry.role, "user");
    assert_eq!(entry.text, "hello");
    assert!(entry.reasoning.is_none());
}

#[test]
fn convert_agent_message_to_history_entry() {
    let value = json!({ "type": "agent_message", "message": "hi there" });
    let entry = convert_history_item(&value).expect("expected entry");
    assert_eq!(entry.role, "assistant");
    assert_eq!(entry.text, "hi there");
    assert!(entry.reasoning.is_none());
}

#[test]
fn convert_agent_reasoning_to_history_entry() {
    let value = json!({ "type": "agent_reasoning", "text": "thinking" });
    let entry = convert_history_item(&value).expect("expected entry");
    assert_eq!(entry.role, "reasoning");
    assert_eq!(entry.text, "");
    assert_eq!(entry.reasoning.as_deref(), Some("thinking"));
}

#[test]
fn reasoning_summary_is_ignored_use_process_only() {
    // 同时存在 summary 与过程：history 仅记录事件中的 process（可能多条），summary 忽略
    let content = r#"
{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}
{"type":"event_msg","payload":{"type":"agent_reasoning","text":"proc-1"}}
{"type":"event_msg","payload":{"type":"agent_reasoning","text":"proc-2"}}
{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"sum-1"},{"type":"summary_text","text":"sum-2"}]}}
{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}
"#;
    let parsed = super::rollout_parser::parse_rollout(content);
    let history = parsed.history;
    // 可能为 4 项（user, reasoning(proc-1), reasoning(proc-2), assistant）
    assert_eq!(history.len(), 4);
    assert_eq!(history[0].role, "user");
    assert_eq!(history[1].role, "reasoning");
    assert_eq!(history[1].reasoning.as_deref(), Some("proc-1"));
    assert_eq!(history[2].role, "reasoning");
    assert_eq!(history[2].reasoning.as_deref(), Some("proc-2"));
    assert_eq!(history[3].role, "assistant");
}

#[test]
fn map_turn_basic_events() {
    let content = load_fixture("turn_basic");
    let parsed = parse_rollout(content);
    let events = parsed.events;
    let methods: Vec<String> = events.iter().map(|(ev, _)| event(ev.clone()).0).collect();
    assert!(methods.contains(&"chat.turn.started".to_string()));
    assert!(methods.contains(&"chat.reasoning.delta".to_string()));
    assert!(methods.contains(&"chat.tool.exec.begin".to_string()));
    assert!(methods.contains(&"chat.tool.exec.output".to_string()));
    assert!(methods.contains(&"chat.tool.exec.end".to_string()));
    assert!(methods.contains(&"chat.message.delta".to_string()));
    assert!(methods.contains(&"chat.message.completed".to_string()));
    assert!(methods.contains(&"chat.turn.complete".to_string()));
    // turnSeq all 1
    for (_, seq) in events {
        assert_eq!(seq, Some(1));
    }
}

#[test]
fn http_resume_filters_out_deltas() {
    // resume 场景：应去除 chat.message.delta 与 chat.reasoning.delta，避免刷新后刷屏
    let content = r#"
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"event_msg","payload":{"type":"agent_reasoning_delta","delta":"r1"}}
{"type":"event_msg","payload":{"type":"agent_reasoning","text":"thinking done"}}
{"type":"event_msg","payload":{"type":"agent_message_delta","delta":"p1"}}
{"type":"event_msg","payload":{"type":"agent_message_delta","delta":"p2"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"final"}}
{"type":"event_msg","payload":{"type":"task_complete"}}
"#;
    let parsed = parse_rollout(content);
    let filtered = super::service::filter_events_for_http_resume(&parsed.events);
    let methods: Vec<String> = filtered.iter().map(|(ev, _)| event(ev.clone()).0).collect();
    assert!(methods.contains(&"chat.turn.started".to_string()));
    assert!(methods.contains(&"chat.reasoning.end".to_string()));
    assert!(methods.contains(&"chat.message.completed".to_string()));
    assert!(methods.contains(&"chat.turn.complete".to_string()));
    assert!(methods.iter().all(|m| m != "chat.message.delta"));
    assert!(methods.iter().all(|m| m != "chat.reasoning.delta"));
    assert!(methods.iter().all(|m| m != "chat.reasoning.raw_delta"));
}

#[test]
fn map_consecutive_agent_messages_as_separate_turns() {
    let content = load_fixture("consecutive_agent");
    let parsed = parse_rollout(content);
    let seqs: Vec<usize> = parsed
        .events
        .into_iter()
        .filter_map(|(ev, seq)| match ev {
            ChatEvent::MessageCompleted { .. } => seq,
            _ => None,
        })
        .collect();
    assert_eq!(seqs, vec![1, 2]);
}

#[test]
fn map_structured_reasoning_item_events() {
    let content = r#"
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"event_msg","payload":{"type":"item_started","item":{"id":"itm-1","typ":"reasoning"}}}
{"type":"event_msg","payload":{"type":"reasoning_content_delta","delta":"plan","item_id":"itm-1"}}
{"type":"event_msg","payload":{"type":"reasoning_raw_content_delta","delta":"raw-plan","item_id":"itm-1"}}
{"type":"event_msg","payload":{"type":"item_completed","item":{"id":"itm-1","typ":"reasoning"},"summary_text":"final summary","raw_content":"raw full"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}
{"type":"event_msg","payload":{"type":"task_complete"}}
"#;
    let parsed = parse_rollout(content);
    let methods: Vec<String> = parsed
        .events
        .iter()
        .map(|(ev, _)| event(ev.clone()).0)
        .collect();
    assert!(methods.contains(&"chat.reasoning.item_started".to_string()));
    assert!(methods.contains(&"chat.reasoning.delta".to_string()));
    assert!(methods.contains(&"chat.reasoning.raw_delta".to_string()));
    assert!(methods.contains(&"chat.reasoning.item_completed".to_string()));
    let reasoning_end = parsed
        .events
        .iter()
        .find_map(|(ev, _)| match ev {
            ChatEvent::ReasoningEnd {
                text,
                item_id,
                raw_content,
            } => Some((text.clone(), item_id.clone(), raw_content.clone())),
            _ => None,
        })
        .expect("reasoning end");
    assert_eq!(reasoning_end.0, "final summary");
    assert_eq!(reasoning_end.1.as_deref(), Some("itm-1"));
    assert_eq!(reasoning_end.2.as_deref(), Some("raw full"));
}

#[test]
fn map_failed_and_aborted_turns() {
    let content = load_fixture("failed_abort");
    let parsed = parse_rollout(content);
    let methods: Vec<String> = parsed
        .events
        .iter()
        .map(|(ev, _)| event(ev.clone()).0)
        .collect();
    assert!(
        methods
            .iter()
            .filter(|m| m.as_str() == "chat.message.failed")
            .count()
            >= 1
    );
    assert!(
        methods
            .iter()
            .filter(|m| m.as_str() == "chat.message.aborted")
            .count()
            >= 1
    );
    assert!(
        methods
            .iter()
            .filter(|m| m.as_str() == "chat.turn.complete")
            .count()
            >= 2
    );
}

#[test]
fn build_resume_config_workspace_write() {
    let content = load_fixture("workspace_write");
    let parsed = parse_rollout(content);
    let (overrides, response) = build_resume_config(&parsed.snapshot);
    assert_eq!(response.sandbox.as_ref().unwrap().mode, "workspace-write");
    assert_eq!(response.approval_policy.as_deref(), Some("on-request"));
    assert_eq!(response.cwd.as_deref(), Some("/Users/test/project"));
    assert_eq!(overrides.sandbox_mode, Some(SandboxMode::WorkspaceWrite));
}

#[test]
fn build_resume_config_environment_only() {
    let content = load_fixture("environment_only");
    let parsed = parse_rollout(content);
    let (overrides, response) = build_resume_config(&parsed.snapshot);
    assert_eq!(response.approval_policy.as_deref(), Some("untrusted"));
    assert_eq!(response.sandbox.as_ref().unwrap().mode, "read-only");
    assert_eq!(overrides.sandbox_mode, Some(SandboxMode::ReadOnly));
    assert_eq!(
        overrides.cwd.as_deref(),
        Some(Path::new("/Users/test/readonly"))
    );
}

#[test]
fn build_resume_config_danger_full_access() {
    let content = load_fixture("danger_full_access");
    let parsed = parse_rollout(content);
    let (_overrides, response) = build_resume_config(&parsed.snapshot);
    assert_eq!(
        response.sandbox.as_ref().unwrap().mode,
        "danger-full-access"
    );
}

#[test]
fn build_resume_config_handles_absent_context() {
    let content = load_fixture("no_context");
    let parsed = parse_rollout(content);
    assert!(parsed.snapshot.turn.is_none());
    assert!(parsed.snapshot.environment.is_none());
    let (overrides, response) = build_resume_config(&parsed.snapshot);
    assert!(overrides.model.is_none());
    assert!(response.model.is_none());
    assert!(response.overrides.is_none());
}

#[test]
fn into_resume_event_payload_injects_turn_seq() {
    use super::service::into_resume_event_payload;
    let ev = ChatEvent::MessageCompleted { text: None };
    let payload = into_resume_event_payload((ev, Some(3)));
    assert_eq!(payload.method, "chat.message.completed");
    let turn = payload
        .params
        .as_ref()
        .and_then(|v| v.get("turnSeq"))
        .and_then(|v| v.as_u64())
        .unwrap();
    assert_eq!(turn, 3);
}

#[test]
fn map_patch_events_basic() {
    // Minimal JSONL with patch begin/end
    let content = r#"
{"type":"event_msg","payload":{"type":"patch_apply_begin","call_id":"c1","adds":1,"dels":0,"changes":{"a.txt":"add"},"auto_approved":true}}
{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"c1","success":true}}
"#;
    let parsed = parse_rollout(content);
    let events = parsed.events;
    let mut begin_seq: Option<usize> = None;
    let mut end_seq: Option<usize> = None;
    for (ev, seq) in events {
        match ev {
            ChatEvent::ToolPatchBegin { .. } => begin_seq = seq,
            ChatEvent::ToolPatchEnd { .. } => end_seq = seq,
            _ => {}
        }
    }
    assert_eq!(begin_seq, Some(1));
    assert_eq!(end_seq, Some(1));
}

#[test]
fn map_custom_tool_apply_patch_into_patch_events() {
    let content = r#"
{"type":"response_item","payload":{"type":"custom_tool_call","status":"completed","call_id":"patch-call-1","name":"apply_patch","input":{"patch":"*** Begin Patch\n*** Update File: src/main.rs\n@@\n-old line\n+new line\n*** End Patch"}}}
"#;
    let parsed = parse_rollout(content);
    let mut begin: Option<(ChatEvent, Option<usize>)> = None;
    let mut end: Option<(ChatEvent, Option<usize>)> = None;
    for (ev, seq) in parsed.events {
        match ev {
            ChatEvent::ToolPatchBegin { .. } => begin = Some((ev, seq)),
            ChatEvent::ToolPatchEnd { .. } => end = Some((ev, seq)),
            _ => {}
        }
    }

    let (begin_event, begin_seq) = begin.expect("expected ToolPatchBegin emitted");
    let (end_event, end_seq) = end.expect("expected ToolPatchEnd emitted");

    assert_eq!(begin_seq, Some(1));
    assert_eq!(end_seq, Some(1));

    if let ChatEvent::ToolPatchBegin {
        call_id,
        files,
        changes,
        ..
    } = begin_event
    {
        assert_eq!(call_id.as_deref(), Some("patch-call-1"));
        assert!(files >= 1, "expected at least one patched file");
        let diff_body = match changes {
            Some(Value::Object(map)) => map.values().find_map(|entry| {
                entry
                    .as_object()
                    .and_then(|obj| obj.get("update"))
                    .and_then(|upd| upd.get("unified_diff"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            }),
            _ => None,
        }
        .unwrap_or_default();
        assert!(diff_body.contains("+new line"));
    } else {
        panic!("unexpected event variant");
    }

    if let ChatEvent::ToolPatchEnd {
        call_id, success, ..
    } = end_event
    {
        assert_eq!(call_id.as_deref(), Some("patch-call-1"));
        assert!(success);
    } else {
        panic!("unexpected event variant");
    }
}

#[test]
fn map_info_plan_update_and_turn_diff() {
    // 包含 plan_update 与 turn_diff，验证被映射为 chat.info.*，且隶属当前 turn（turnSeq=1）
    let content = r#"
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"event_msg","payload":{"type":"plan_update","explanation":"E","plan":[{"step":"a","status":"in_progress"}]}}
{"type":"event_msg","payload":{"type":"turn_diff","unified_diff":"--- a\n+++ b\n+line"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}
{"type":"event_msg","payload":{"type":"task_complete"}}
"#;
    let parsed = parse_rollout(content);
    let mut has_plan = false;
    let mut has_diff = false;
    let mut seq_plan: Option<usize> = None;
    let mut seq_diff: Option<usize> = None;
    for (ev, seq) in parsed.events {
        let (method, _params) = event(ev.clone());
        if method == "chat.info.plan_update" {
            has_plan = true;
            seq_plan = seq;
        }
        if method == "chat.info.turn_diff" {
            has_diff = true;
            seq_diff = seq;
        }
    }
    assert!(has_plan, "expected chat.info.plan_update in events");
    assert!(has_diff, "expected chat.info.turn_diff in events");
    assert_eq!(seq_plan, Some(1));
    assert_eq!(seq_diff, Some(1));
}

#[test]
fn map_function_call_update_plan_as_info_plan_update() {
    // function_call:update_plan（来自 rollout response_item）应被映射为 chat.info.plan_update，附着于当前 turn
    let content = r#"
{"type":"event_msg","payload":{"type":"task_started"}}
{"type":"response_item","payload":{"type":"function_call","name":"update_plan","call_id":"call_plan_1","arguments":"{\"plan\":[{\"step\":\"定位新会话创建与事件流\",\"status\":\"in_progress\"},{\"step\":\"梳理后端事件入环与resume\",\"status\":\"pending\"}],\"explanation\":\"初始计划\"}"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}
{"type":"event_msg","payload":{"type":"task_complete"}}
"#;
    let parsed = parse_rollout(content);
    let mut has_plan = false;
    let mut seq_plan: Option<usize> = None;
    for (ev, seq) in parsed.events {
        let (method, params) = event(ev.clone());
        if method == "chat.info.plan_update" {
            has_plan = true;
            seq_plan = seq;
            // 基本字段存在
            assert!(params.get("plan").is_some());
        }
    }
    assert!(
        has_plan,
        "expected chat.info.plan_update mapped from function_call:update_plan"
    );
    assert_eq!(seq_plan, Some(1));
}

#[test]
fn exec_event_path_with_output_before_begin() {
    // output_delta arrives before begin; accumulator should insert a placeholder begin
    let content = r#"
{"type":"event_msg","payload":{"type":"exec_command_output_delta","call_id":"c2","text":"hello"}}
{"type":"event_msg","payload":{"type":"exec_command_end","call_id":"c2","exit_code":0}}
"#;
    let parsed = parse_rollout(content);
    let methods: Vec<String> = parsed
        .events
        .iter()
        .map(|(ev, _)| event(ev.clone()).0)
        .collect();
    // TurnStarted, ToolExecBegin (placeholder), ToolExecOutput, ToolExecEnd
    assert!(methods.len() >= 4);
    assert_eq!(methods[0], "chat.turn.started");
    assert_eq!(methods[1], "chat.tool.exec.begin");
    assert_eq!(methods[2], "chat.tool.exec.output");
    assert!(methods.contains(&"chat.tool.exec.end".to_string()));
}

#[test]
fn mcp_event_path_begin_end() {
    let content = r#"
{"type":"event_msg","payload":{"type":"mcp_tool_call_begin","call_id":"m1","invocation":{"server":"sv","tool":"tl","arguments":{"q":1}}}}
{"type":"event_msg","payload":{"type":"mcp_tool_call_end","call_id":"m1","invocation":{"server":"sv","tool":"tl","arguments":{"q":1}},"result":{"ok":true}}}
"#;
    let parsed = parse_rollout(content);
    let methods: Vec<String> = parsed
        .events
        .iter()
        .map(|(ev, _)| event(ev.clone()).0)
        .collect();
    assert!(methods.contains(&"chat.tool.mcp.begin".to_string()));
    assert!(methods.contains(&"chat.tool.mcp.end".to_string()));
}

#[test]
fn mcp_response_item_function_call_and_output() {
    // preferred name format: <server>__<tool>
    let content = r#"
{"type":"response_item","payload":{"type":"function_call","name":"sv__tl","arguments":"{\"arguments\":{\"x\":1}}","call_id":"mid"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"mid","output":"{\"output\":\"{\\\"ok\\\":true}\"}"}}
"#;
    let parsed = parse_rollout(content);
    let methods: Vec<String> = parsed
        .events
        .iter()
        .map(|(ev, _)| event(ev.clone()).0)
        .collect();
    assert!(methods.contains(&"chat.tool.mcp.begin".to_string()));
    assert!(methods.contains(&"chat.tool.mcp.end".to_string()));
}

#[test]
fn mcp_response_item_legacy_name_mcp_prefix_double_underscore() {
    // legacy name format: mcp__server__tool
    let content = r#"
{"type":"response_item","payload":{"type":"function_call","name":"mcp__sv__tl","arguments":"{\"arguments\":{\"x\":1}}","call_id":"mid"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"mid","output":"{\"output\":\"{\\\"ok\\\":true}\"}"}}
"#;
    let parsed = parse_rollout(content);
    let methods: Vec<String> = parsed
        .events
        .iter()
        .map(|(ev, _)| event(ev.clone()).0)
        .collect();
    assert!(methods.contains(&"chat.tool.mcp.begin".to_string()));
    assert!(methods.contains(&"chat.tool.mcp.end".to_string()));
}

#[test]
fn in_progress_true_on_unmatched_function_call_begin() {
    use std::fs;
    let dir = std::env::temp_dir().join(format!("ailoom_inprogress_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("d.jsonl");
    // 有 function_call 开始，但没有 function_call_output
    let content = r#"
{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"bash\",\"-lc\",\"sleep 5\"]}","call_id":"sid"}}
"#;
    fs::write(&path, content.trim_start()).unwrap();
    // 即使 idle 超过阈值，仍应视为进行中（未匹配到输出）
    let prev_idle = std::env::var("AILOOM_CODEX_ROLLOUT_IDLE_MS").ok();
    std::env::set_var("AILOOM_CODEX_ROLLOUT_IDLE_MS", "1");
    let res = rollout_in_progress(path.to_string_lossy().as_ref());
    match prev_idle {
        Some(val) => std::env::set_var("AILOOM_CODEX_ROLLOUT_IDLE_MS", val),
        None => std::env::remove_var("AILOOM_CODEX_ROLLOUT_IDLE_MS"),
    }
    assert_eq!(res, Some(true));
}

#[test]
fn in_progress_true_on_unmatched_exec_begin() {
    use std::fs;
    let dir = std::env::temp_dir().join(format!("ailoom_inprogress_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("e.jsonl");
    // 有 exec_command_begin，但没有 exec_command_end
    let content = r#"
{"type":"event_msg","payload":{"type":"exec_command_begin","call_id":"c1","command":["bash","-lc","sleep 10"]}}
"#;
    fs::write(&path, content.trim_start()).unwrap();
    let prev_idle = std::env::var("AILOOM_CODEX_ROLLOUT_IDLE_MS").ok();
    std::env::set_var("AILOOM_CODEX_ROLLOUT_IDLE_MS", "1");
    let res = rollout_in_progress(path.to_string_lossy().as_ref());
    match prev_idle {
        Some(val) => std::env::set_var("AILOOM_CODEX_ROLLOUT_IDLE_MS", val),
        None => std::env::remove_var("AILOOM_CODEX_ROLLOUT_IDLE_MS"),
    }
    assert_eq!(res, Some(true));
}

#[test]
fn mcp_response_item_legacy_name_colon_slash() {
    // legacy name format: mcp:server/tool
    let content = r#"
{"type":"response_item","payload":{"type":"function_call","name":"mcp:sv/tl","arguments":"{\"arguments\":{\"x\":1}}","call_id":"mid"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"mid","output":"{\"output\":\"{\\\"ok\\\":true}\"}"}}
"#;
    let parsed = parse_rollout(content);
    let methods: Vec<String> = parsed
        .events
        .iter()
        .map(|(ev, _)| event(ev.clone()).0)
        .collect();
    assert!(methods.contains(&"chat.tool.mcp.begin".to_string()));
    assert!(methods.contains(&"chat.tool.mcp.end".to_string()));
}

#[test]
fn shell_function_call_output_without_metadata_still_ends() {
    let content = r#"
{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"bash\",\"-lc\",\"echo hi\"]}","call_id":"sid"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"sid","output":"{\"output\":\"hi\\n\"}"}}
"#;
    let parsed = parse_rollout(content);
    let methods: Vec<String> = parsed
        .events
        .iter()
        .map(|(ev, _)| event(ev.clone()).0)
        .collect();
    assert!(methods.contains(&"chat.tool.exec.begin".to_string()));
    assert!(methods.contains(&"chat.tool.exec.output".to_string()));
    // finish() should flush a synthetic exec.end when metadata is absent
    assert!(methods.contains(&"chat.tool.exec.end".to_string()));
}

#[test]
fn parse_real_codex_sessions_if_available() {
    use std::fs;
    use std::path::PathBuf;
    let root = PathBuf::from("/Users/yoyo/.codex/sessions");
    if !root.exists() {
        return;
    }
    let mut checked = 0usize;
    let mut ok = false;
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        if checked >= 3 {
            break;
        }
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let _parsed = parse_rollout(&content);
            ok = true;
            checked += 1;
            if checked >= 3 {
                break;
            }
        }
    }
    // 如果没有找到任何 jsonl，直接返回不失败
    if !ok {
        return;
    }
}

#[test]
fn in_progress_false_on_task_complete() {
    use std::fs;
    let dir = std::env::temp_dir().join(format!("ailoom_inprogress_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("a.jsonl");
    let content = r#"
{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}
{"type":"event_msg","payload":{"type":"agent_message","message":"ok"}}
{"type":"event_msg","payload":{"type":"task_complete"}}
"#;
    fs::write(&path, content.trim_start()).unwrap();
    // 即刻判断：应为 false（已完成）
    let res = rollout_in_progress(path.to_string_lossy().as_ref());
    assert_eq!(res, Some(false));
}

#[test]
fn in_progress_true_on_recent_delta() {
    use std::fs;
    let dir = std::env::temp_dir().join(format!("ailoom_inprogress_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("b.jsonl");
    let content = r#"
{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}
{"type":"event_msg","payload":{"type":"agent_message_delta","delta":"..."}}
"#;
    fs::write(&path, content.trim_start()).unwrap();
    // 提高阈值，确保视为“活跃”
    let prev_idle = std::env::var("AILOOM_CODEX_ROLLOUT_IDLE_MS").ok();
    std::env::set_var("AILOOM_CODEX_ROLLOUT_IDLE_MS", "60000");
    let res = rollout_in_progress(path.to_string_lossy().as_ref());
    match prev_idle {
        Some(val) => std::env::set_var("AILOOM_CODEX_ROLLOUT_IDLE_MS", val),
        None => std::env::remove_var("AILOOM_CODEX_ROLLOUT_IDLE_MS"),
    }
    assert_eq!(res, Some(true));
}

// 备注：关于“非终结事件 + idle 阈值”判断由于不同文件系统的 mtime 粒度差异，
// 在单测环境容易产生非确定性，这里不做时间阈值的断言，仅通过运行时逻辑保障。
