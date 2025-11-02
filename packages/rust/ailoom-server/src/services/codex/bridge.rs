use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use codex_app_server_protocol::{
    JSONRPCNotification, ServerNotification, SessionConfiguredNotification,
};
use codex_protocol::protocol::RateLimitSnapshot;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone)]
pub struct BroadcastEvent {
    pub method: String,
    pub params: Value,
    pub persistent: bool,
}

impl BroadcastEvent {
    pub fn persistent(method: impl Into<String>, params: Value) -> Self {
        Self {
            method: method.into(),
            params,
            persistent: true,
        }
    }

    pub fn ephemeral(method: impl Into<String>, params: Value) -> Self {
        Self {
            method: method.into(),
            params,
            persistent: false,
        }
    }
}

// Track active conversations for multi-session broadcasting.
fn active_conversations() -> &'static Mutex<HashSet<String>> {
    static STATE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn active_conversation_ids() -> Vec<String> {
    active_conversations()
        .lock()
        .map(|set| set.iter().cloned().collect())
        .unwrap_or_default()
}

pub(crate) fn store_conversation_id(id: &str) {
    if let Ok(mut guard) = active_conversations().lock() {
        guard.insert(id.to_string());
    }
}

fn remove_conversation_id(id: &str) {
    if let Ok(mut guard) = active_conversations().lock() {
        guard.remove(id);
    }
}

fn any_conversation_id() -> Option<String> {
    active_conversations()
        .lock()
        .ok()
        .and_then(|set| set.iter().next().cloned())
}

fn single_active_conversation_id() -> Option<String> {
    active_conversations().lock().ok().and_then(|set| {
        if set.len() == 1 {
            set.iter().next().cloned()
        } else {
            None
        }
    })
}

pub fn map_notification_to_chat_events(notification: &JSONRPCNotification) -> Vec<BroadcastEvent> {
    if !notification.method.starts_with("codex/event/") {
        return vec![];
    }

    let Some(params_obj) = notification
        .params
        .as_ref()
        .and_then(|value| value.as_object())
    else {
        return vec![];
    };

    // 优先使用通知内显式携带的 conversationId；如缺失且仅存在单一活跃会话，则做一次安全回退。
    let conversation_id = notification
        .params
        .as_ref()
        .and_then(extract_conversation_id)
        .or_else(single_active_conversation_id);

    if conversation_id.is_none() {
        tracing::warn!(target: "codex.map", method=%notification.method, "notification 缺少 conversationId，后续 chat.* 可能无法按会话过滤");
    }

    if let Some(ref cid) = conversation_id {
        store_conversation_id(cid);
    }

    let Some(msg_value) = params_obj.get("msg") else {
        return vec![];
    };
    let Some(msg_obj) = msg_value.as_object() else {
        return vec![];
    };
    let msg_map = msg_obj.clone();

    let Some(kind) = msg_map.get("type").and_then(|v| v.as_str()) else {
        return vec![];
    };

    let mut events = map_runtime_event(kind, &msg_map, conversation_id.as_deref());
    // 安全阀：chat.* 事件必须带 conversationId；若缺失则丢弃并打点，避免污染 ring 与造成 gating 噪声。
    if events.iter().any(|e| e.method.starts_with("chat.")) {
        let before = events.len();
        events.retain(|e| {
            if !e.method.starts_with("chat.") {
                return true;
            }
            e.params
                .get("conversationId")
                .and_then(|v| v.as_str())
                .is_some()
        });
        if events.len() < before {
            tracing::debug!(target:"codex.map", kind=%kind, "丢弃缺少 conversationId 的 chat.* 事件，避免串会话");
        }
    }
    if events.is_empty() {
        tracing::debug!(target: "codex.map", kind=%kind, "runtime 事件未映射或为空");
    }
    events
}

pub fn map_notification(notification: &JSONRPCNotification) -> Vec<BroadcastEvent> {
    if let Ok(server) = ServerNotification::try_from(notification.clone()) {
        return map_server_notification(server);
    }

    map_generic_notification(notification)
}

fn map_server_notification(notification: ServerNotification) -> Vec<BroadcastEvent> {
    match notification {
        ServerNotification::SessionConfigured(payload) => {
            vec![map_session_configured(payload)]
        }
        ServerNotification::AccountRateLimitsUpdated(snapshot) => {
            map_rate_limits_snapshot(snapshot)
        }
        ServerNotification::AuthStatusChange(payload) => {
            let params = provider_payload(
                Some(serde_json::to_value(payload).unwrap_or(Value::Null)),
                None,
            );
            vec![BroadcastEvent::ephemeral("codex/authStatusChange", params)]
        }
        ServerNotification::LoginChatGptComplete(payload) => {
            let params = provider_payload(
                Some(serde_json::to_value(payload).unwrap_or(Value::Null)),
                None,
            );
            vec![BroadcastEvent::ephemeral(
                "codex/auth/loginChatGptComplete",
                params,
            )]
        }
    }
}

fn map_session_configured(payload: SessionConfiguredNotification) -> BroadcastEvent {
    let conversation_id = payload.session_id.to_string();
    store_conversation_id(&conversation_id);

    let mut map = Map::new();
    map.insert("provider".into(), Value::String("codex".into()));
    map.insert("sessionId".into(), Value::String(conversation_id.clone()));
    map.insert(
        "conversationId".into(),
        Value::String(conversation_id.clone()),
    );
    map.insert("model".into(), Value::String(payload.model.clone()));
    if let Some(effort) = payload.reasoning_effort {
        map.insert(
            "reasoningEffort".into(),
            serde_json::to_value(effort).unwrap_or(Value::Null),
        );
    }
    map.insert(
        "historyLogId".into(),
        serde_json::to_value(payload.history_log_id).unwrap_or(Value::Null),
    );
    map.insert(
        "historyEntryCount".into(),
        serde_json::to_value(payload.history_entry_count).unwrap_or(Value::Null),
    );
    map.insert(
        "rolloutPath".into(),
        Value::String(payload.rollout_path.to_string_lossy().to_string()),
    );
    if let Some(initial) = payload.initial_messages {
        map.insert(
            "initialMessages".into(),
            serde_json::to_value(initial).unwrap_or(Value::Null),
        );
    }

    BroadcastEvent::ephemeral("codex/sessionConfigured", Value::Object(map))
}

fn map_rate_limits_snapshot(snapshot: RateLimitSnapshot) -> Vec<BroadcastEvent> {
    let set = active_conversations().lock().unwrap().clone();
    let mut out: Vec<BroadcastEvent> = Vec::new();
    if set.is_empty() {
        let mut map = Map::new();
        map.insert("provider".into(), Value::String("codex".into()));
        map.insert(
            "rateLimits".into(),
            serde_json::to_value(snapshot).unwrap_or(Value::Null),
        );
        out.push(BroadcastEvent::ephemeral(
            "codex/account/rateLimits/updated",
            Value::Object(map),
        ));
        return out;
    }
    for cid in set.into_iter() {
        let mut map = Map::new();
        map.insert("conversationId".into(), Value::String(cid));
        map.insert("provider".into(), Value::String("codex".into()));
        map.insert(
            "rateLimits".into(),
            serde_json::to_value(&snapshot).unwrap_or(Value::Null),
        );
        out.push(BroadcastEvent::ephemeral(
            "codex/account/rateLimits/updated",
            Value::Object(map),
        ));
    }
    out
}

fn map_generic_notification(notification: &JSONRPCNotification) -> Vec<BroadcastEvent> {
    let mut events = Vec::new();
    let conversation_id = notification
        .params
        .as_ref()
        .and_then(extract_conversation_id)
        .or_else(any_conversation_id);

    if let Some(ref cid) = conversation_id {
        store_conversation_id(cid);
    }

    if notification.method.starts_with("codex/event/") {
        if let Some(extra) = derive_rate_limits_event(notification.params.as_ref()) {
            let payload = provider_payload(Some(extra), conversation_id.clone());
            events.push(BroadcastEvent::ephemeral(
                "codex/account/rateLimits/updated",
                payload,
            ));
        }
    } else {
        let method = if notification.method.starts_with("codex/") {
            notification.method.clone()
        } else {
            format!("codex/{}", notification.method)
        };

        let provider_params =
            provider_payload(notification.params.clone(), conversation_id.clone());
        events.push(BroadcastEvent::ephemeral(method.clone(), provider_params));

        if let Some(extra) = derive_rate_limits_event(notification.params.as_ref()) {
            let payload = provider_payload(Some(extra), conversation_id.clone());
            events.push(BroadcastEvent::ephemeral(
                "codex/account/rateLimits/updated",
                payload,
            ));
        }
    }

    if notification.method.starts_with("codex/event/") {
        if let Some(params) = notification.params.as_ref() {
            if let Some(obj) = params.as_object() {
                if let Some(msg) = obj.get("msg").and_then(|v| v.as_object()) {
                    if matches!(
                        msg.get("type").and_then(|v| v.as_str()),
                        Some("shutdown_complete")
                    ) {
                        if let Some(cid) = extract_conversation_id(params) {
                            remove_conversation_id(&cid);
                        }
                    }
                }
            }
        }
    }

    events
}

fn map_runtime_event(
    kind: &str,
    msg: &Map<String, Value>,
    conversation_id: Option<&str>,
) -> Vec<BroadcastEvent> {
    let cid = conversation_id;
    match kind {
        "task_started" => {
            let mut payload = Map::new();
            if let Some(window) = msg.get("model_context_window").and_then(|v| v.as_u64()) {
                payload.insert("modelContextWindow".into(), json!(window));
            }
            vec![BroadcastEvent::ephemeral(
                "chat.turn.started",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "agent_message_delta" => {
            let delta = msg
                .get("delta")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if delta.is_empty() {
                return Vec::new();
            }
            let mut payload = Map::new();
            payload.insert("delta".into(), Value::String(delta));
            vec![BroadcastEvent::persistent(
                "chat.message.delta",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "agent_message" => {
            let text = msg
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut payload = Map::new();
            payload.insert("text".into(), Value::String(text.clone()));
            if text.trim().eq_ignore_ascii_case("compact task completed") {
                payload.insert("special".into(), Value::String("compact_done".into()));
            }
            vec![BroadcastEvent::persistent(
                "chat.message.completed",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "agent_reasoning_raw_content" => Vec::new(),
        "agent_reasoning_delta" => {
            let delta = msg
                .get("delta")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if delta.is_empty() {
                return Vec::new();
            }
            let mut payload = Map::new();
            payload.insert("delta".into(), Value::String(delta));
            vec![BroadcastEvent::ephemeral(
                "chat.reasoning.delta",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "agent_reasoning" => {
            let text = msg
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut payload = Map::new();
            payload.insert("text".into(), Value::String(text));
            vec![BroadcastEvent::persistent(
                "chat.reasoning.end",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "agent_reasoning_section_break" => vec![BroadcastEvent::ephemeral(
            "chat.reasoning.section_break",
            attach_conversation_id(Value::Null, cid),
        )],
        "exec_command_begin" => {
            let command = msg.get("command").map(string_array).unwrap_or_default();
            let cwd = msg
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut payload = Map::new();
            payload.insert(
                "command".into(),
                Value::Array(command.into_iter().map(Value::String).collect()),
            );
            if let Some(cwd) = cwd {
                payload.insert("cwd".into(), Value::String(cwd));
            }
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            vec![BroadcastEvent::persistent(
                "chat.tool.exec.begin",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "exec_command_output_delta" => {
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let stream = msg
                .get("stream")
                .and_then(|v| v.as_str())
                .unwrap_or("stdout")
                .to_string();
            let chunk = msg
                .get("chunk")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let text = decode_base64_text(&chunk).unwrap_or_else(|| chunk.clone());
            let mut payload = Map::new();
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            payload.insert("stream".into(), Value::String(stream));
            if !chunk.is_empty() {
                payload.insert("chunk".into(), Value::String(chunk));
            }
            payload.insert("text".into(), Value::String(text));
            vec![BroadcastEvent::persistent(
                "chat.tool.exec.output",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "exec_command_end" => {
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut payload = Map::new();
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            if let Some(exit_code) = msg.get("exit_code") {
                payload.insert("exitCode".into(), exit_code.clone());
            }
            if let Some(duration) = msg.get("duration") {
                payload.insert("duration".into(), duration.clone());
            }
            if let Some(stdout) = msg.get("stdout") {
                payload.insert("stdout".into(), stdout.clone());
            }
            if let Some(stderr) = msg.get("stderr") {
                payload.insert("stderr".into(), stderr.clone());
            }
            if let Some(agg) = msg.get("aggregated_output") {
                payload.insert("aggregatedOutput".into(), agg.clone());
            }
            if let Some(formatted) = msg.get("formatted_output") {
                payload.insert("formattedOutput".into(), formatted.clone());
            }
            vec![BroadcastEvent::persistent(
                "chat.tool.exec.end",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "patch_apply_begin" => {
            let changes = msg
                .get("changes")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            let files = changes.as_object().map(|m| m.len()).unwrap_or(0);
            let first_path = changes.as_object().and_then(|m| m.keys().next().cloned());
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut payload = Map::new();
            payload.insert("files".into(), json!(files));
            payload.insert(
                "autoApproved".into(),
                Value::Bool(
                    msg.get("auto_approved")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                ),
            );
            if let Some(first_path) = first_path {
                payload.insert("firstPath".into(), Value::String(first_path));
            }
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            // Optional: precomputed change stats if available
            if let Some(adds) = msg.get("adds") {
                payload.insert("adds".into(), adds.clone());
            }
            if let Some(dels) = msg.get("dels") {
                payload.insert("dels".into(), dels.clone());
            }
            payload.insert("changes".into(), changes);
            vec![BroadcastEvent::persistent(
                "chat.tool.patch.begin",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "patch_apply_end" => {
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut payload = Map::new();
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            payload.insert(
                "success".into(),
                Value::Bool(msg.get("success").and_then(|v| v.as_bool()).unwrap_or(true)),
            );
            if let Some(stdout) = msg.get("stdout") {
                payload.insert("stdout".into(), stdout.clone());
            }
            if let Some(stderr) = msg.get("stderr") {
                payload.insert("stderr".into(), stderr.clone());
            }
            vec![BroadcastEvent::persistent(
                "chat.tool.patch.end",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "mcp_tool_call_begin" => {
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let invocation = msg
                .get("invocation")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_else(Map::new);
            let mut payload = Map::new();
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            if let Some(server) = invocation.get("server").and_then(|v| v.as_str()) {
                payload.insert("server".into(), Value::String(server.to_string()));
            }
            if let Some(tool) = invocation.get("tool").and_then(|v| v.as_str()) {
                payload.insert("tool".into(), Value::String(tool.to_string()));
            }
            if let Some(arguments) = invocation.get("arguments") {
                payload.insert("arguments".into(), arguments.clone());
            }
            vec![BroadcastEvent::persistent(
                "chat.tool.mcp.begin",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "mcp_tool_call_end" => {
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let invocation = msg
                .get("invocation")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_else(Map::new);
            let mut payload = Map::new();
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            if let Some(server) = invocation.get("server").and_then(|v| v.as_str()) {
                payload.insert("server".into(), Value::String(server.to_string()));
            }
            if let Some(tool) = invocation.get("tool").and_then(|v| v.as_str()) {
                payload.insert("tool".into(), Value::String(tool.to_string()));
            }
            if let Some(arguments) = invocation.get("arguments") {
                payload.insert("arguments".into(), arguments.clone());
            }
            if let Some(result) = msg.get("result") {
                payload.insert("result".into(), result.clone());
            }
            vec![BroadcastEvent::persistent(
                "chat.tool.mcp.end",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "user_message" => {
            let text = msg
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                return Vec::new();
            }
            let mut payload = Map::new();
            payload.insert("text".into(), Value::String(text));
            if let Some(kind) = msg.get("kind") {
                payload.insert("kind".into(), kind.clone());
            }
            vec![BroadcastEvent::persistent(
                "chat.info.user_message",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "web_search_begin" => {
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut payload = Map::new();
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            vec![BroadcastEvent::persistent(
                "chat.info.web_search.begin",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "web_search_end" => {
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut payload = Map::new();
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            if let Some(query) = msg.get("query").and_then(|v| v.as_str()) {
                payload.insert("query".into(), Value::String(query.to_string()));
            }
            vec![BroadcastEvent::persistent(
                "chat.info.web_search.end",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "task_complete" => vec![BroadcastEvent::persistent(
            "chat.turn.complete",
            attach_conversation_id(Value::Null, cid),
        )],
        "turn_aborted" => {
            let mut payload = Map::new();
            if let Some(reason) = msg.get("reason").and_then(|v| v.as_str()) {
                payload.insert("reason".into(), Value::String(reason.to_string()));
            }
            vec![BroadcastEvent::persistent(
                "chat.message.aborted",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "stream_error" | "error" => {
            let message = msg
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("执行失败")
                .to_string();
            let payload = json!({
                "error": {
                    "message": message,
                }
            });
            vec![BroadcastEvent::persistent(
                "chat.message.failed",
                attach_conversation_id(payload, cid),
            )]
        }
        "token_count" => Vec::new(),
        "turn_diff" => {
            let diff = msg
                .get("unified_diff")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if diff.is_empty() {
                return Vec::new();
            }
            let mut payload = Map::new();
            payload.insert("diff".into(), Value::String(diff));
            vec![BroadcastEvent::persistent(
                "chat.info.turn_diff",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "plan_update" => {
            let plan = msg
                .get("plan")
                .cloned()
                .unwrap_or_else(|| Value::Array(vec![]));
            let explanation = msg
                .get("explanation")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut payload = Map::new();
            payload.insert("plan".into(), plan);
            payload.insert("explanation".into(), Value::String(explanation));
            vec![BroadcastEvent::persistent(
                "chat.info.plan_update",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "exec_approval_request" => {
            let command = msg.get("command").map(string_array).unwrap_or_default();
            let cwd = msg
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut payload = Map::new();
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            payload.insert(
                "command".into(),
                Value::Array(command.into_iter().map(Value::String).collect()),
            );
            if let Some(cwd) = cwd {
                payload.insert("cwd".into(), Value::String(cwd));
            }
            if let Some(reason) = msg.get("reason").and_then(|v| v.as_str()) {
                payload.insert("reason".into(), Value::String(reason.to_string()));
            }
            vec![BroadcastEvent::persistent(
                "chat.info.approval.exec",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "apply_patch_approval_request" => {
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut payload = Map::new();
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            if let Some(reason) = msg.get("reason").and_then(|v| v.as_str()) {
                payload.insert("reason".into(), Value::String(reason.to_string()));
            }
            if let Some(grant_root) = msg.get("grant_root").and_then(|v| v.as_str()) {
                payload.insert("grantRoot".into(), Value::String(grant_root.to_string()));
            }
            let change_count = msg
                .get("changes")
                .and_then(|v| v.as_object())
                .map(|m| m.len())
                .unwrap_or(0);
            payload.insert("changeCount".into(), json!(change_count));
            vec![BroadcastEvent::persistent(
                "chat.info.approval.patch",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "background_event" => {
            let message = msg
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if message.is_empty() {
                return Vec::new();
            }
            let mut payload = Map::new();
            payload.insert("message".into(), Value::String(message));
            vec![BroadcastEvent::persistent(
                "chat.info.background",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "view_image_tool_call" => {
            let call_id = msg
                .get("call_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut payload = Map::new();
            if let Some(call_id) = call_id {
                payload.insert("callId".into(), Value::String(call_id));
            }
            if let Some(path) = msg.get("path") {
                payload.insert("path".into(), path.clone());
            }
            vec![BroadcastEvent::persistent(
                "chat.info.view_image",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "conversation_path" => {
            let mut payload = Map::new();
            if let Some(path) = msg.get("path") {
                payload.insert("path".into(), path.clone());
            }
            vec![BroadcastEvent::persistent(
                "chat.info.conversation_path",
                attach_conversation_id(Value::Object(payload), cid),
            )]
        }
        "entered_review_mode" => vec![BroadcastEvent::persistent(
            "chat.info.review.entered",
            attach_conversation_id(Value::Null, cid),
        )],
        "exited_review_mode" => vec![BroadcastEvent::persistent(
            "chat.info.review.exited",
            attach_conversation_id(Value::Null, cid),
        )],
        _ => Vec::new(),
    }
}

fn attach_conversation_id(params: Value, conversation_id: Option<&str>) -> Value {
    // 最小改造：所有 chat.* 事件统一注入 provider="codex"，并在存在时注入 conversationId
    let mut ensured = match params {
        Value::Null => Map::new(),
        Value::Object(map) => map,
        other => {
            let mut map = Map::new();
            map.insert("value".into(), other);
            map
        }
    };
    if let Some(cid) = conversation_id {
        ensured
            .entry("conversationId".to_string())
            .or_insert(Value::String(cid.to_string()));
    }
    ensured
        .entry("provider".to_string())
        .or_insert(Value::String("codex".into()));
    Value::Object(ensured)
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn decode_base64_text(chunk: &str) -> Option<String> {
    let bytes = BASE64_STANDARD.decode(chunk).ok()?;
    String::from_utf8(bytes).ok()
}

fn provider_payload(params: Option<Value>, conversation_id: Option<String>) -> Value {
    match params {
        Some(Value::Object(mut map)) => {
            if let Some(cid) = conversation_id {
                map.entry("conversationId".to_string())
                    .or_insert(Value::String(cid));
            }
            map.entry("provider".to_string())
                .or_insert(Value::String("codex".into()));
            Value::Object(map)
        }
        Some(other) => {
            let mut map = Map::new();
            if let Some(cid) = conversation_id {
                map.insert("conversationId".to_string(), Value::String(cid));
            }
            map.insert("provider".to_string(), Value::String("codex".into()));
            map.insert("payload".into(), other);
            Value::Object(map)
        }
        None => {
            let mut map = Map::new();
            if let Some(cid) = conversation_id {
                map.insert("conversationId".to_string(), Value::String(cid));
            }
            map.insert("provider".to_string(), Value::String("codex".into()));
            Value::Object(map)
        }
    }
}

fn extract_conversation_id(value: &Value) -> Option<String> {
    if let Some(obj) = value.as_object() {
        for key in [
            "conversationId",
            "conversation_id",
            "sessionId",
            "session_id",
        ] {
            if let Some(id) = obj.get(key).and_then(|v| v.as_str()) {
                return Some(id.to_string());
            }
        }
        if let Some(msg) = obj.get("msg") {
            return extract_conversation_id(msg);
        }
        if let Some(payload) = obj.get("payload") {
            return extract_conversation_id(payload);
        }
    }
    None
}

fn derive_rate_limits_event(params: Option<&Value>) -> Option<Value> {
    let params = params?.as_object()?;
    let msg = params.get("msg")?.as_object()?;
    let msg_type = msg.get("type")?.as_str()?;
    if msg_type != "token_count" {
        return None;
    }
    let rate_limits = msg.get("rate_limits")?;
    if rate_limits.is_null() {
        return None;
    }
    let mut payload = Map::new();
    payload.insert("rateLimits".into(), rate_limits.clone());
    Some(Value::Object(payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_notification_to_chat_events_maps_agent_message() {
        let notification = JSONRPCNotification {
            method: "codex/event/runtime".into(),
            params: Some(json!({
                "conversationId": "cid-1",
                "msg": { "type": "agent_message", "message": "hello world" }
            })),
        };

        let events = map_notification_to_chat_events(&notification);
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert!(ev.persistent);
        assert_eq!(ev.method, "chat.message.completed");
        assert_eq!(
            ev.params.get("conversationId").and_then(|v| v.as_str()),
            Some("cid-1")
        );
        assert_eq!(
            ev.params.get("text").and_then(|v| v.as_str()),
            Some("hello world")
        );

        // cleanup
        super::remove_conversation_id("cid-1");
    }

    #[test]
    fn map_notification_to_chat_events_marks_reasoning_delta_ephemeral() {
        let notification = JSONRPCNotification {
            method: "codex/event/runtime".into(),
            params: Some(json!({
                "conversationId": "cid-2",
                "msg": { "type": "agent_reasoning_delta", "delta": "thinking" }
            })),
        };

        let events = map_notification_to_chat_events(&notification);
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert!(!ev.persistent);
        assert_eq!(ev.method, "chat.reasoning.delta");
        assert_eq!(
            ev.params.get("conversationId").and_then(|v| v.as_str()),
            Some("cid-2")
        );

        super::remove_conversation_id("cid-2");
    }

    #[test]
    fn map_notification_to_chat_events_decodes_exec_output_chunk() {
        let notification = JSONRPCNotification {
            method: "codex/event/runtime".into(),
            params: Some(json!({
                "conversationId": "cid-3",
                "msg": {
                    "type": "exec_command_output_delta",
                    "call_id": "call-1",
                    "stream": "stdout",
                    "chunk": "aGVsbG8=",
                }
            })),
        };

        let events = map_notification_to_chat_events(&notification);
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert!(ev.persistent);
        assert_eq!(ev.method, "chat.tool.exec.output");
        assert_eq!(
            ev.params.get("conversationId").and_then(|v| v.as_str()),
            Some("cid-3")
        );
        assert_eq!(
            ev.params.get("text").and_then(|v| v.as_str()),
            Some("hello")
        );
        assert_eq!(
            ev.params.get("chunk").and_then(|v| v.as_str()),
            Some("aGVsbG8=")
        );

        super::remove_conversation_id("cid-3");
    }

    #[test]
    fn map_notification_to_chat_events_maps_web_search_begin_end() {
        // begin
        let begin = JSONRPCNotification {
            method: "codex/event/runtime".into(),
            params: Some(json!({
                "conversationId": "cid-ws",
                "msg": { "type": "web_search_begin", "call_id": "ws-1" }
            })),
        };
        let evs_begin = map_notification_to_chat_events(&begin);
        assert_eq!(evs_begin.len(), 1);
        let evb = &evs_begin[0];
        assert_eq!(evb.method, "chat.info.web_search.begin");
        let p = evb.params.as_object().unwrap();
        assert_eq!(p.get("callId").and_then(|v| v.as_str()), Some("ws-1"));
        assert_eq!(
            p.get("conversationId").and_then(|v| v.as_str()),
            Some("cid-ws")
        );

        // end
        let end = JSONRPCNotification {
            method: "codex/event/runtime".into(),
            params: Some(json!({
                "conversationId": "cid-ws",
                "msg": { "type": "web_search_end", "call_id": "ws-1", "query": "vite hmr" }
            })),
        };
        let evs_end = map_notification_to_chat_events(&end);
        assert_eq!(evs_end.len(), 1);
        let eve = &evs_end[0];
        assert_eq!(eve.method, "chat.info.web_search.end");
        let p2 = eve.params.as_object().unwrap();
        assert_eq!(p2.get("callId").and_then(|v| v.as_str()), Some("ws-1"));
        assert_eq!(p2.get("query").and_then(|v| v.as_str()), Some("vite hmr"));
        assert_eq!(
            p2.get("conversationId").and_then(|v| v.as_str()),
            Some("cid-ws")
        );

        super::remove_conversation_id("cid-ws");
    }

    #[test]
    fn map_notification_to_chat_events_maps_approval_requests() {
        // exec approval
        let exec_appr = JSONRPCNotification {
            method: "codex/event/runtime".into(),
            params: Some(json!({
                "conversationId": "cid-appr",
                "msg": {
                    "type": "exec_approval_request",
                    "call_id": "exec-1",
                    "command": ["bash","-lc","echo ok"],
                    "cwd": "/tmp",
                    "reason": "ask"
                }
            })),
        };
        let evs_exec = map_notification_to_chat_events(&exec_appr);
        assert_eq!(evs_exec.len(), 1);
        let e = &evs_exec[0];
        assert_eq!(e.method, "chat.info.approval.exec");
        let pe = e.params.as_object().unwrap();
        assert_eq!(pe.get("callId").and_then(|v| v.as_str()), Some("exec-1"));
        assert_eq!(pe.get("cwd").and_then(|v| v.as_str()), Some("/tmp"));
        assert_eq!(pe.get("reason").and_then(|v| v.as_str()), Some("ask"));
        let cmd = pe
            .get("command")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap();
        assert_eq!(cmd.len(), 3);
        assert_eq!(
            pe.get("conversationId").and_then(|v| v.as_str()),
            Some("cid-appr")
        );

        // patch approval
        let patch_appr = JSONRPCNotification {
            method: "codex/event/runtime".into(),
            params: Some(json!({
                "conversationId": "cid-appr",
                "msg": {
                    "type": "apply_patch_approval_request",
                    "call_id": "patch-1",
                    "reason": "bulk",
                    "grant_root": "/workspace",
                    "changes": {"a.ts": {"update":{}}, "b.ts": {"add":{}}}
                }
            })),
        };
        let evs_patch = map_notification_to_chat_events(&patch_appr);
        assert_eq!(evs_patch.len(), 1);
        let p = &evs_patch[0];
        assert_eq!(p.method, "chat.info.approval.patch");
        let pp = p.params.as_object().unwrap();
        assert_eq!(pp.get("callId").and_then(|v| v.as_str()), Some("patch-1"));
        assert_eq!(pp.get("reason").and_then(|v| v.as_str()), Some("bulk"));
        assert_eq!(
            pp.get("grantRoot").and_then(|v| v.as_str()),
            Some("/workspace")
        );
        assert_eq!(pp.get("changeCount").and_then(|v| v.as_u64()), Some(2));

        super::remove_conversation_id("cid-appr");
    }
    #[test]
    fn map_notification_injects_provider_codex() {
        let notification = JSONRPCNotification {
            method: "codex/event/runtime".into(),
            params: Some(json!({
                "conversationId": "cid-prov",
                "msg": { "type": "agent_message", "message": "hello" }
            })),
        };
        let events = map_notification_to_chat_events(&notification);
        assert_eq!(events.len(), 1);
        let ev = &events[0];
        assert_eq!(ev.method, "chat.message.completed");
        assert_eq!(
            ev.params.get("provider").and_then(|v| v.as_str()),
            Some("codex")
        );
        assert_eq!(
            ev.params.get("conversationId").and_then(|v| v.as_str()),
            Some("cid-prov")
        );
        super::remove_conversation_id("cid-prov");
    }
}
