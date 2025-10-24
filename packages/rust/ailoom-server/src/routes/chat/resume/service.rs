use crate::state::AppState;
use crate::ws::chat_events::{event, ChatEvent, ChatHistoryEntry};
use serde_json::{json, Value};

use super::types::{ResumeEventPayload};

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

pub fn broadcast_resume(state: &AppState, conversation_id: &str, history: &[ChatHistoryEntry]) {
    if let Some(hub) = state.ws_hub.clone() {
        let (m, p) = event(ChatEvent::SessionResumed {
            conversation_id: conversation_id.to_string(),
        });
        hub.broadcast(m, p);
        if !history.is_empty() {
            let (hm, hp) = event(ChatEvent::SessionHistory {
                conversation_id: conversation_id.to_string(),
                messages: history.to_vec(),
            });
            hub.broadcast(hm, hp);
        }
    }
}

