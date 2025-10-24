use crate::ws::chat_events::ChatHistoryEntry;
use serde_json::Value;

pub fn convert_history_item(value: &Value) -> Option<ChatHistoryEntry> {
    let typ = value.get("type")?.as_str()?;
    match typ {
        "user_message" => {
            let text = value.get("message")?.as_str()?.to_string();
            Some(ChatHistoryEntry {
                role: "user".into(),
                text,
                reasoning: None,
            })
        }
        "agent_message" => {
            let text = value.get("message")?.as_str()?.to_string();
            Some(ChatHistoryEntry {
                role: "assistant".into(),
                text,
                reasoning: None,
            })
        }
        "agent_reasoning" => {
            let text = value.get("text")?.as_str()?.to_string();
            Some(ChatHistoryEntry {
                role: "reasoning".into(),
                text: String::new(),
                reasoning: Some(text),
            })
        }
        _ => None,
    }
}

