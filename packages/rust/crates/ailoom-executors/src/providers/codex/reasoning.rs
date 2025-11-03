use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub enum ReasoningOutput {
    ContentDelta {
        delta: String,
        item_id: Option<String>,
        source: Option<String>,
    },
    RawDelta {
        delta: String,
        item_id: Option<String>,
    },
    ItemStarted {
        item_id: String,
    },
    ItemCompleted {
        item_id: String,
    },
    FinalSummary {
        item_id: Option<String>,
        text: String,
        raw_content: Option<String>,
    },
    SectionBreak {
        item_id: Option<String>,
    },
}

#[derive(Default)]
pub struct ReasoningTracker {
    saw_structured_items: bool,
    items: HashMap<String, ReasoningItemState>,
    last_item_id: Option<String>,
    legacy_content: Vec<String>,
    legacy_raw: Vec<String>,
}

#[derive(Default, Clone)]
struct ReasoningItemState {
    content: String,
    raw: String,
}

impl ReasoningTracker {
    pub fn handle_event(&mut self, kind: &str, msg: &Map<String, Value>) -> Vec<ReasoningOutput> {
        match kind {
            "reasoning_content_delta" | "reasoning.content.delta" => {
                self.handle_structured_content_delta(msg)
            }
            "reasoning_raw_content_delta" | "reasoning.raw_content.delta" => {
                self.handle_structured_raw_delta(msg)
            }
            "item_started" | "reasoning_item_started" => self.handle_structured_item_started(msg),
            "item_completed" | "reasoning_item_completed" => {
                self.handle_structured_item_completed(msg)
            }
            "agent_reasoning_delta" => self.handle_legacy_content_delta(msg),
            "agent_reasoning_raw_content" => self.handle_legacy_raw_delta(msg),
            "agent_reasoning" => self.handle_legacy_reasoning_end(msg),
            "agent_reasoning_section_break" | "reasoning_section_break" => {
                self.handle_section_break()
            }
            _ => Vec::new(),
        }
    }

    pub fn flush(&mut self) -> Vec<ReasoningOutput> {
        let mut outputs = Vec::new();
        if self.saw_structured_items {
            let mut remaining = std::mem::take(&mut self.items);
            for (item_id, state) in remaining.drain() {
                outputs.push(ReasoningOutput::ItemCompleted {
                    item_id: item_id.clone(),
                });
                let text = normalize_summary(&state.content);
                let raw = normalize_optional(&state.raw);
                outputs.push(ReasoningOutput::FinalSummary {
                    item_id: Some(item_id),
                    text,
                    raw_content: raw,
                });
            }
        } else {
            let text = self.legacy_content.join("");
            let raw = normalize_optional(&self.legacy_raw.join(""));
            if !text.is_empty() || raw.is_some() {
                outputs.push(ReasoningOutput::FinalSummary {
                    item_id: None,
                    text,
                    raw_content: raw,
                });
            }
            self.legacy_content.clear();
            self.legacy_raw.clear();
        }
        self.last_item_id = None;
        outputs
    }

    fn handle_structured_content_delta(
        &mut self,
        msg: &Map<String, Value>,
    ) -> Vec<ReasoningOutput> {
        let Some(delta) = extract_text_field(msg, &["delta", "content", "text"]) else {
            return Vec::new();
        };
        self.saw_structured_items = true;
        let item_id = extract_reasoning_item_id(msg).or_else(|| self.last_item_id.clone());
        if let Some(ref id) = item_id {
            let entry = self.items.entry(id.clone()).or_default();
            entry.content.push_str(&delta);
            self.last_item_id = Some(id.clone());
        }
        vec![ReasoningOutput::ContentDelta {
            delta,
            item_id,
            source: Some("content".to_string()),
        }]
    }

    fn handle_structured_raw_delta(&mut self, msg: &Map<String, Value>) -> Vec<ReasoningOutput> {
        let Some(delta) = extract_text_field(msg, &["delta", "content", "text"]) else {
            return Vec::new();
        };
        self.saw_structured_items = true;
        let item_id = extract_reasoning_item_id(msg).or_else(|| self.last_item_id.clone());
        if let Some(ref id) = item_id {
            let entry = self.items.entry(id.clone()).or_default();
            entry.raw.push_str(&delta);
            self.last_item_id = Some(id.clone());
        }
        vec![ReasoningOutput::RawDelta { delta, item_id }]
    }

    fn handle_structured_item_started(&mut self, msg: &Map<String, Value>) -> Vec<ReasoningOutput> {
        if !is_reasoning_item(msg) {
            return Vec::new();
        }
        let Some(item_id) = extract_reasoning_item_id(msg) else {
            return Vec::new();
        };
        self.saw_structured_items = true;
        self.items.entry(item_id.clone()).or_default();
        self.last_item_id = Some(item_id.clone());
        vec![ReasoningOutput::ItemStarted { item_id }]
    }

    fn handle_structured_item_completed(
        &mut self,
        msg: &Map<String, Value>,
    ) -> Vec<ReasoningOutput> {
        if !is_reasoning_item(msg) {
            return Vec::new();
        }
        let Some(item_id) = extract_reasoning_item_id(msg) else {
            return Vec::new();
        };
        self.saw_structured_items = true;
        let entry = self.items.remove(&item_id).unwrap_or_default();
        let summary = extract_reasoning_summary(msg)
            .or_else(|| Some(normalize_summary(&entry.content)))
            .unwrap_or_default();
        let raw = extract_raw_reasoning_content(msg).or_else(|| normalize_optional(&entry.raw));
        self.last_item_id = None;
        vec![
            ReasoningOutput::ItemCompleted {
                item_id: item_id.clone(),
            },
            ReasoningOutput::FinalSummary {
                item_id: Some(item_id),
                text: summary,
                raw_content: raw,
            },
        ]
    }

    fn handle_legacy_content_delta(&mut self, msg: &Map<String, Value>) -> Vec<ReasoningOutput> {
        if self.saw_structured_items {
            return Vec::new();
        }
        let Some(delta) = extract_text_field(msg, &["delta", "text"]) else {
            return Vec::new();
        };
        self.legacy_content.push(delta.clone());
        vec![ReasoningOutput::ContentDelta {
            delta,
            item_id: None,
            source: None,
        }]
    }

    fn handle_legacy_raw_delta(&mut self, msg: &Map<String, Value>) -> Vec<ReasoningOutput> {
        if self.saw_structured_items {
            return Vec::new();
        }
        let Some(delta) = extract_text_field(msg, &["delta", "text"]) else {
            return Vec::new();
        };
        self.legacy_raw.push(delta.clone());
        vec![ReasoningOutput::RawDelta {
            delta,
            item_id: None,
        }]
    }

    fn handle_legacy_reasoning_end(&mut self, msg: &Map<String, Value>) -> Vec<ReasoningOutput> {
        if self.saw_structured_items {
            return Vec::new();
        }
        let fallback = self.legacy_content.join("");
        let mut text = msg
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();
        if text.trim().is_empty() {
            text = fallback;
        }
        let raw = if self.legacy_raw.is_empty() {
            None
        } else {
            Some(self.legacy_raw.join(""))
        };
        self.legacy_content.clear();
        self.legacy_raw.clear();
        self.last_item_id = None;
        vec![ReasoningOutput::FinalSummary {
            item_id: None,
            text,
            raw_content: raw,
        }]
    }

    fn handle_section_break(&mut self) -> Vec<ReasoningOutput> {
        if self.saw_structured_items {
            vec![ReasoningOutput::SectionBreak {
                item_id: self.last_item_id.clone(),
            }]
        } else {
            self.legacy_content.push("\n---\n".to_string());
            vec![ReasoningOutput::SectionBreak { item_id: None }]
        }
    }
}

pub fn extract_reasoning_item_id(msg: &Map<String, Value>) -> Option<String> {
    if let Some(item_id) = msg.get("item_id").and_then(|v| v.as_str()) {
        return Some(item_id.to_string());
    }
    if let Some(item_obj) = msg.get("item").and_then(|v| v.as_object()) {
        if let Some(id) = item_obj.get("id").and_then(|v| v.as_str()) {
            return Some(id.to_string());
        }
        if let Some(id) = item_obj.get("item_id").and_then(|v| v.as_str()) {
            return Some(id.to_string());
        }
    }
    None
}

pub fn is_reasoning_item(msg: &Map<String, Value>) -> bool {
    msg.get("item_type")
        .or_else(|| msg.get("item_kind"))
        .and_then(|v| v.as_str())
        .map(|s| s.eq_ignore_ascii_case("reasoning"))
        .unwrap_or_else(|| {
            msg.get("item")
                .and_then(|v| v.as_object())
                .and_then(|item| {
                    item.get("typ")
                        .or_else(|| item.get("type"))
                        .and_then(|v| v.as_str())
                })
                .map(|s| s.eq_ignore_ascii_case("reasoning"))
                .unwrap_or(false)
        })
        || msg.contains_key("summary_text")
        || msg.contains_key("raw_content")
}

pub fn extract_reasoning_summary(msg: &Map<String, Value>) -> Option<String> {
    msg.get("summary_text")
        .or_else(|| msg.get("summary"))
        .or_else(|| msg.get("text"))
        .and_then(extract_text_value)
}

pub fn extract_raw_reasoning_content(msg: &Map<String, Value>) -> Option<String> {
    msg.get("raw_content")
        .or_else(|| msg.get("raw"))
        .and_then(extract_text_value)
}

fn extract_text_field(msg: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = msg.get(*key) {
            if let Some(text) = extract_text_value(value) {
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
    }
    None
}

fn extract_text_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.to_string()),
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                if let Some(s) = extract_text_value(item) {
                    parts.push(s);
                }
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(|v| v.as_str()) {
                return Some(text.to_string());
            }
            if let Some(delta) = map.get("delta").and_then(|v| v.as_str()) {
                return Some(delta.to_string());
            }
            None
        }
        _ => None,
    }
}

fn normalize_summary(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        trimmed.to_string()
    }
}

fn normalize_optional(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map_from_pairs(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect::<Map<_, _>>()
    }

    #[test]
    fn structured_reasoning_flow() {
        let mut tracker = ReasoningTracker::default();
        let started = map_from_pairs(&[("item", json!({"id":"itm-1","typ":"reasoning"}))]);
        let deltas = map_from_pairs(&[
            ("delta", Value::String("plan".into())),
            ("item_id", Value::String("itm-1".into())),
        ]);
        let raw = map_from_pairs(&[
            ("delta", Value::String("raw".into())),
            ("item_id", Value::String("itm-1".into())),
        ]);
        let completed = map_from_pairs(&[
            ("item", json!({"id":"itm-1","typ":"reasoning"})),
            ("summary_text", Value::String("final".into())),
            ("raw_content", Value::String("rawfull".into())),
        ]);

        assert!(matches!(
            tracker.handle_event("item_started", &started)[0],
            ReasoningOutput::ItemStarted { .. }
        ));
        assert!(matches!(
            tracker.handle_event("reasoning_content_delta", &deltas)[0],
            ReasoningOutput::ContentDelta { .. }
        ));
        assert!(matches!(
            tracker.handle_event("reasoning_raw_content_delta", &raw)[0],
            ReasoningOutput::RawDelta { .. }
        ));
        let outputs = tracker.handle_event("item_completed", &completed);
        assert_eq!(outputs.len(), 2);
        match (&outputs[0], &outputs[1]) {
            (
                ReasoningOutput::ItemCompleted { item_id: a },
                ReasoningOutput::FinalSummary {
                    item_id: b,
                    text,
                    raw_content,
                },
            ) => {
                assert_eq!(a, "itm-1");
                assert_eq!(b.as_deref(), Some("itm-1"));
                assert_eq!(text, "final");
                assert_eq!(raw_content.as_deref(), Some("rawfull"));
            }
            _ => panic!("unexpected outputs"),
        }
    }

    #[test]
    fn legacy_reasoning_flow() {
        let mut tracker = ReasoningTracker::default();
        let delta = map_from_pairs(&[("delta", Value::String("think".into()))]);
        let raw = map_from_pairs(&[("delta", Value::String("raw".into()))]);
        let end = map_from_pairs(&[("text", Value::String("final".into()))]);

        tracker.handle_event("agent_reasoning_delta", &delta);
        tracker.handle_event("agent_reasoning_raw_content", &raw);
        let outputs = tracker.handle_event("agent_reasoning", &end);
        assert_eq!(outputs.len(), 1);
        match &outputs[0] {
            ReasoningOutput::FinalSummary {
                text, raw_content, ..
            } => {
                assert!(text.contains("final"));
                assert_eq!(raw_content.as_deref(), Some("raw"));
            }
            _ => panic!("expected final summary"),
        }
    }
}
