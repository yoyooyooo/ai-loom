#![cfg(test)]
use super::history::convert_history_item;
use super::rollout_parser::parse_rollout;
use super::config::build_resume_config;
use crate::ws::chat_events::{event, ChatEvent};
use codex_protocol::config_types::SandboxMode;
use serde_json::json;
use std::path::Path;

fn load_fixture(name: &str) -> &'static str {
    match name {
        "workspace_write" => { include_str!("../../../../tests/fixtures/rollouts/workspace_write.jsonl") }
        "environment_only" => { include_str!("../../../../tests/fixtures/rollouts/environment_only.jsonl") }
        "danger_full_access" => { include_str!("../../../../tests/fixtures/rollouts/danger_full_access.jsonl") }
        "no_context" => include_str!("../../../../tests/fixtures/rollouts/no_context.jsonl"),
        "turn_basic" => include_str!("../../../../tests/fixtures/rollouts/turn_basic.jsonl"),
        "consecutive_agent" => { include_str!("../../../../tests/fixtures/rollouts/consecutive_agent.jsonl") }
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
fn map_failed_and_aborted_turns() {
    let content = load_fixture("failed_abort");
    let parsed = parse_rollout(content);
    let methods: Vec<String> = parsed
        .events
        .iter()
        .map(|(ev, _)| event(ev.clone()).0)
        .collect();
    assert!(methods.iter().filter(|m| m.as_str() == "chat.message.failed").count() >= 1);
    assert!(methods.iter().filter(|m| m.as_str() == "chat.message.aborted").count() >= 1);
    assert!(methods.iter().filter(|m| m.as_str() == "chat.turn.complete").count() >= 2);
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
    assert_eq!(overrides.cwd.as_deref(), Some(Path::new("/Users/test/readonly")));
}

#[test]
fn build_resume_config_danger_full_access() {
    let content = load_fixture("danger_full_access");
    let parsed = parse_rollout(content);
    let (_overrides, response) = build_resume_config(&parsed.snapshot);
    assert_eq!(response.sandbox.as_ref().unwrap().mode, "danger-full-access");
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
    let mut begin_seq: Option<usize> = None;
    let mut end_seq: Option<usize> = None;
    for (ev, seq) in parsed.events {
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
fn exec_event_path_with_output_before_begin() {
    // output_delta arrives before begin; accumulator should insert a placeholder begin
    let content = r#"
{"type":"event_msg","payload":{"type":"exec_command_output_delta","call_id":"c2","text":"hello"}}
{"type":"event_msg","payload":{"type":"exec_command_end","call_id":"c2","exit_code":0}}
"#;
    let parsed = parse_rollout(content);
    let methods: Vec<String> = parsed.events.iter().map(|(ev, _)| event(ev.clone()).0).collect();
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
    let methods: Vec<String> = parsed.events.iter().map(|(ev, _)| event(ev.clone()).0).collect();
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
    let methods: Vec<String> = parsed.events.iter().map(|(ev, _)| event(ev.clone()).0).collect();
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
    let methods: Vec<String> = parsed.events.iter().map(|(ev, _)| event(ev.clone()).0).collect();
    assert!(methods.contains(&"chat.tool.mcp.begin".to_string()));
    assert!(methods.contains(&"chat.tool.mcp.end".to_string()));
}

#[test]
fn mcp_response_item_legacy_name_colon_slash() {
    // legacy name format: mcp:server/tool
    let content = r#"
{"type":"response_item","payload":{"type":"function_call","name":"mcp:sv/tl","arguments":"{\"arguments\":{\"x\":1}}","call_id":"mid"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"mid","output":"{\"output\":\"{\\\"ok\\\":true}\"}"}}
"#;
    let parsed = parse_rollout(content);
    let methods: Vec<String> = parsed.events.iter().map(|(ev, _)| event(ev.clone()).0).collect();
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
    let methods: Vec<String> = parsed.events.iter().map(|(ev, _)| event(ev.clone()).0).collect();
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
    if !root.exists() { return; }
    let mut checked = 0usize;
    let mut ok = false;
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        if checked >= 3 { break; }
        let Ok(rd) = fs::read_dir(&dir) else { continue; };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() { stack.push(path); continue; }
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
            let Ok(content) = fs::read_to_string(&path) else { continue; };
            let _parsed = parse_rollout(&content);
            ok = true;
            checked += 1;
            if checked >= 3 { break; }
        }
    }
    // 如果没有找到任何 jsonl，直接返回不失败
    if !ok { return; }
}
