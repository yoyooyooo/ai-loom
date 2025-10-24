use std::sync::{Mutex, OnceLock};

use codex_app_server_protocol::{
    JSONRPCNotification, ServerNotification, SessionConfiguredNotification,
};
use codex_protocol::protocol::RateLimitSnapshot;
use serde_json::{Map, Value};

#[derive(Debug, Clone)]
pub struct BroadcastEvent {
    pub method: String,
    pub params: Value,
}

fn conversation_state() -> &'static Mutex<Option<String>> {
    static STATE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

pub(crate) fn store_conversation_id(id: &str) {
    if let Ok(mut guard) = conversation_state().lock() {
        *guard = Some(id.to_string());
    }
}

fn current_conversation_id() -> Option<String> {
    conversation_state()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
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
            vec![map_rate_limits_snapshot(snapshot)]
        }
        ServerNotification::AuthStatusChange(payload) => {
            let params = provider_payload(
                Some(serde_json::to_value(payload).unwrap_or(Value::Null)),
                None,
            );
            vec![BroadcastEvent {
                method: "codex/authStatusChange".into(),
                params,
            }]
        }
        ServerNotification::LoginChatGptComplete(payload) => {
            let params = provider_payload(
                Some(serde_json::to_value(payload).unwrap_or(Value::Null)),
                None,
            );
            vec![BroadcastEvent {
                method: "codex/auth/loginChatGptComplete".into(),
                params,
            }]
        }
    }
}

fn map_session_configured(payload: SessionConfiguredNotification) -> BroadcastEvent {
    let conversation_id = payload.session_id.to_string();
    store_conversation_id(&conversation_id);

    let mut map = Map::new();
    map.insert("provider".into(), Value::String("codex".into()));
    map.insert("sessionId".into(), Value::String(conversation_id.clone()));
    map.insert("conversationId".into(), Value::String(conversation_id));
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

    BroadcastEvent {
        method: "codex/sessionConfigured".into(),
        params: Value::Object(map),
    }
}

fn map_rate_limits_snapshot(snapshot: RateLimitSnapshot) -> BroadcastEvent {
    let mut map = Map::new();
    if let Some(cid) = current_conversation_id() {
        map.insert("conversationId".into(), Value::String(cid));
    }
    map.insert("provider".into(), Value::String("codex".into()));
    map.insert(
        "rateLimits".into(),
        serde_json::to_value(snapshot).unwrap_or(Value::Null),
    );
    BroadcastEvent {
        method: "codex/account/rateLimits/updated".into(),
        params: Value::Object(map),
    }
}

fn map_generic_notification(notification: &JSONRPCNotification) -> Vec<BroadcastEvent> {
    let mut events = Vec::new();
    let conversation_id = notification
        .params
        .as_ref()
        .and_then(extract_conversation_id)
        .or_else(current_conversation_id);

    if let Some(ref cid) = conversation_id {
        store_conversation_id(cid);
    }

    let method = if notification.method.starts_with("codex/") {
        notification.method.clone()
    } else {
        format!("codex/{}", notification.method)
    };

    let provider_params = provider_payload(notification.params.clone(), conversation_id.clone());
    events.push(BroadcastEvent {
        method: method.clone(),
        params: provider_params,
    });

    if let Some(extra) = derive_rate_limits_event(notification.params.as_ref()) {
        let payload = provider_payload(Some(extra), conversation_id.clone());
        events.push(BroadcastEvent {
            method: "codex/account/rateLimits/updated".into(),
            params: payload,
        });
    }

    events
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
