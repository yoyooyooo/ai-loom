use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

#[derive(Debug, Clone)]
pub struct Event {
    pub method: String,
    pub params: Value,
}

#[derive(Clone)]
pub struct Hub {
    tx: broadcast::Sender<Event>,
    next_id: Arc<AtomicU64>,
    ring: Arc<Mutex<VecDeque<EventRecord>>>,
    ring_cap: usize,
    stats: Arc<HubStats>,
    recent: Arc<Mutex<HashMap<String, Instant>>>,
    dedup_window: Duration,
    // 会话进度聚合：conversationId -> inProgress
    progress: Arc<Mutex<HashMap<String, bool>>>,
}

impl Hub {
    pub fn new(buffer: usize) -> Self {
        let (tx, _rx) = broadcast::channel(buffer.max(8));
        let dedup_ms = std::env::var("AILOOM_WS_DEDUP_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(200);
        Self {
            tx,
            next_id: Arc::new(AtomicU64::new(1)),
            ring: Arc::new(Mutex::new(VecDeque::with_capacity(buffer))),
            ring_cap: buffer,
            stats: Arc::new(HubStats::default()),
            recent: Arc::new(Mutex::new(HashMap::new())),
            dedup_window: Duration::from_millis(dedup_ms),
            progress: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
    pub fn broadcast(&self, mut method: String, mut params: Value) {
        // 简单去重：对 file.changed 的同一路径在短窗口内只发一次，避免 "保存广播" 与 "监听广播" 双发
        if method == "file.changed" {
            if let Some(path) = params.get("path").and_then(|v| v.as_str()) {
                let mut recent = self.recent.lock().unwrap();
                let key = format!("{}:{}", method, path);
                let now = Instant::now();
                if let Some(last) = recent.get(&key) {
                    if now.duration_since(*last) <= self.dedup_window {
                        return; // drop duplicate
                    }
                }
                recent.insert(key, now);
            }
        }
        // attach ts/eventId if not provided
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let ts = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| "".into());
        if let Some(obj) = params.as_object_mut() {
            obj.entry("ts").or_insert_with(|| Value::String(ts));
            obj.entry("eventId")
                .or_insert_with(|| Value::String(id.to_string()));
        }
        let conversation_id = params
            .get("conversationId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let provider_id = params
            .get("provider")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        // QoS: ring buffer prioritization - avoid evicting high-priority events
        {
            let mut ring = self.ring.lock().unwrap();
            if ring.len() >= self.ring_cap {
                if method == "tree.changed" {
                    // drop this low-priority event from ring (still send live)
                    self.stats
                        .dropped_ring_lowpri
                        .fetch_add(1, Ordering::Relaxed);
                } else {
                    // try to evict a low-priority tree.changed first
                    let pos = ring.iter().position(|e| e.method == "tree.changed");
                    if let Some(i) = pos {
                        ring.remove(i);
                    } else {
                        ring.pop_front();
                    }
                    ring.push_back(EventRecord {
                        id,
                        method: method.clone(),
                        params: params.clone(),
                        conversation_id: conversation_id.clone(),
                        provider_id: provider_id.clone(),
                    });
                }
            } else {
                ring.push_back(EventRecord {
                    id,
                    method: method.clone(),
                    params: params.clone(),
                    conversation_id: conversation_id.clone(),
                    provider_id: provider_id.clone(),
                });
            }
        }
        let method_for_log = method.clone();
        // 进度聚合：根据事件边界维护 inProgress 映射
        self.update_progress(&method_for_log, &params);
        let sent = self.tx.send(Event {
            method: std::mem::take(&mut method),
            params,
        });
        match sent {
            Ok(n) => {
                self.stats.broadcast_total.fetch_add(1, Ordering::Relaxed);
                if n == 0 {
                    self.stats.no_receiver.fetch_add(1, Ordering::Relaxed);
                }
                if std::env::var("AILOOM_WS_TRACE_BROADCAST").unwrap_or_else(|_| "0".into()) == "1"
                {
                    tracing::info!(target: "ws", method=%method_for_log, receivers=%n, ring=%self.ring.lock().unwrap().len(), "broadcast");
                }
            }
            Err(_e) => {
                self.stats.broadcast_errors.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn update_progress(&self, method: &str, params: &Value) {
        // 仅处理 chat.* 且携带 conversationId 的事件
        if !method.starts_with("chat.") {
            return;
        }
        let cid = params
            .get("conversationId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let Some(conversation_id) = cid else { return };
        let start_methods = [
            "chat.turn.started",
            "chat.message.delta",
            "chat.tool.exec.begin",
            "chat.tool.patch.begin",
            "chat.tool.mcp.begin",
        ];
        let end_methods = [
            "chat.message.completed",
            "chat.message.failed",
            "chat.message.aborted",
            "chat.turn.complete",
            "chat.tool.exec.end",
            "chat.tool.patch.end",
            "chat.tool.mcp.end",
        ];
        if start_methods.iter().any(|m| *m == method) {
            if let Ok(mut map) = self.progress.lock() {
                map.insert(conversation_id, true);
            }
        } else if end_methods.iter().any(|m| *m == method) {
            if let Ok(mut map) = self.progress.lock() {
                map.insert(conversation_id, false);
            }
        }
    }

    pub fn get_in_progress(&self, conversation_id: &str) -> Option<bool> {
        self.progress
            .lock()
            .ok()
            .and_then(|m| m.get(conversation_id).copied())
    }

    pub fn resume_after(&self, after: u64) -> (Vec<EventRecord>, bool) {
        let ring = self.ring.lock().unwrap();
        if ring.is_empty() {
            return (vec![], false);
        }
        let oldest = ring.front().map(|e| e.id).unwrap_or(0);
        let truncated = after != 0 && after < oldest;
        let mut out = Vec::new();
        for e in ring.iter() {
            if e.id > after {
                out.push(e.clone());
            }
        }
        (out, truncated)
    }

    pub fn resume_after_chat(
        &self,
        after: u64,
        conversation_id: Option<&str>,
        provider_id: Option<&str>,
    ) -> (Vec<EventRecord>, bool) {
        let ring = self.ring.lock().unwrap();
        if ring.is_empty() {
            return (vec![], false);
        }
        let oldest = ring.front().map(|e| e.id).unwrap_or(0);
        let truncated = after != 0 && after < oldest;
        let mut out = Vec::new();
        for e in ring.iter() {
            if e.id <= after {
                continue;
            }
            if !e.method.starts_with("chat.") {
                continue;
            }
            if let Some(cid) = conversation_id {
                if e.conversation_id.as_deref() != Some(cid) {
                    continue;
                }
            }
            if let Some(pid) = provider_id {
                if e.provider_id.as_deref() != Some(pid) {
                    continue;
                }
            }
            out.push(e.clone());
        }
        (out, truncated)
    }

    pub fn tail(&self, n: usize) -> Vec<EventRecord> {
        let ring = self.ring.lock().unwrap();
        if ring.is_empty() || n == 0 {
            return vec![];
        }
        let len = ring.len();
        let start = len.saturating_sub(n);
        ring.iter().skip(start).cloned().collect()
    }

    pub fn tail_chat(
        &self,
        conversation_id: Option<&str>,
        provider_id: Option<&str>,
        n: usize,
    ) -> Vec<EventRecord> {
        let ring = self.ring.lock().unwrap();
        if ring.is_empty() || n == 0 {
            return vec![];
        }
        let mut out = Vec::new();
        for e in ring.iter().rev() {
            if !e.method.starts_with("chat.") {
                continue;
            }
            if let Some(cid) = conversation_id {
                if e.conversation_id.as_deref() != Some(cid) {
                    continue;
                }
            }
            if let Some(pid) = provider_id {
                if e.provider_id.as_deref() != Some(pid) {
                    continue;
                }
            }
            out.push(e.clone());
            if out.len() >= n {
                break;
            }
        }
        out.reverse();
        out
    }

    /// 获取某会话最近一条事件的 ts（RFC3339 字符串）；若不存在或无 ts 字段则返回 None。
    pub fn last_event_ts_for_conversation(&self, conversation_id: &str) -> Option<String> {
        let ring = self.ring.lock().ok()?;
        for e in ring.iter().rev() {
            if e.conversation_id.as_deref() != Some(conversation_id) {
                continue;
            }
            if let Some(ts) = e.params.get("ts").and_then(|v| v.as_str()) {
                return Some(ts.to_string());
            }
        }
        None
    }

    pub fn stats_snapshot(&self) -> HubStatsOut {
        HubStatsOut {
            broadcast_total: self.stats.broadcast_total.load(Ordering::Relaxed),
            broadcast_errors: self.stats.broadcast_errors.load(Ordering::Relaxed),
            no_receiver: self.stats.no_receiver.load(Ordering::Relaxed),
            dropped_ring_lowpri: self.stats.dropped_ring_lowpri.load(Ordering::Relaxed),
            ring_size: self.ring.lock().unwrap().len() as u64,
            ring_cap: self.ring_cap as u64,
            last_event_id: self.next_id.load(Ordering::Relaxed).saturating_sub(1),
            file_changed_total: self.stats.file_changed_total.load(Ordering::Relaxed),
            tree_changed_batches: self.stats.tree_changed_batches.load(Ordering::Relaxed),
            tree_impacted_paths_total: self.stats.tree_impacted_paths_total.load(Ordering::Relaxed),
            tree_truncated_batches: self.stats.tree_truncated_batches.load(Ordering::Relaxed),
            tree_moved_total: self.stats.tree_moved_total.load(Ordering::Relaxed),
        }
    }

    pub fn inc_file_changed(&self) {
        self.stats
            .file_changed_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn report_tree_changed(&self, impacted_count: usize, moved_count: usize, truncated: bool) {
        self.stats
            .tree_changed_batches
            .fetch_add(1, Ordering::Relaxed);
        self.stats
            .tree_impacted_paths_total
            .fetch_add(impacted_count as u64, Ordering::Relaxed);
        self.stats
            .tree_moved_total
            .fetch_add(moved_count as u64, Ordering::Relaxed);
        if truncated {
            self.stats
                .tree_truncated_batches
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    // 广播“瞬时/观测类”事件：仅发送，不入 ring、不生成事件 id
    // 适用于 session.stats 等无需 resume 的事件，避免污染 ring 导致 resume 错过业务事件
    pub fn broadcast_ephemeral(&self, method: String, params: Value) {
        let sent = self.tx.send(Event { method, params });
        match sent {
            Ok(n) => {
                self.stats.broadcast_total.fetch_add(1, Ordering::Relaxed);
                if n == 0 {
                    self.stats.no_receiver.fetch_add(1, Ordering::Relaxed);
                }
            }
            Err(_e) => {
                self.stats.broadcast_errors.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct EventRecord {
    pub id: u64,
    pub method: String,
    pub params: Value,
    pub conversation_id: Option<String>,
    pub provider_id: Option<String>,
}

#[derive(Default, Debug)]
struct HubStats {
    broadcast_total: AtomicU64,
    broadcast_errors: AtomicU64,
    no_receiver: AtomicU64,
    dropped_ring_lowpri: AtomicU64,
    file_changed_total: AtomicU64,
    tree_changed_batches: AtomicU64,
    tree_impacted_paths_total: AtomicU64,
    tree_truncated_batches: AtomicU64,
    tree_moved_total: AtomicU64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubStatsOut {
    pub broadcast_total: u64,
    pub broadcast_errors: u64,
    pub no_receiver: u64,
    pub dropped_ring_lowpri: u64,
    pub ring_size: u64,
    pub ring_cap: u64,
    pub last_event_id: u64,
    pub file_changed_total: u64,
    pub tree_changed_batches: u64,
    pub tree_impacted_paths_total: u64,
    pub tree_truncated_batches: u64,
    pub tree_moved_total: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resume_after_chat_filters_by_conversation() {
        let hub = Hub::new(8);
        hub.broadcast(
            "chat.message.delta".into(),
            json!({"conversationId":"cid-a","provider":"codex","delta":"hi"}),
        );
        hub.broadcast(
            "chat.message.delta".into(),
            json!({"conversationId":"cid-b","provider":"codex","delta":"yo"}),
        );
        hub.broadcast(
            "chat.tool.exec.end".into(),
            json!({"conversationId":"cid-a","provider":"codex","callId":"exec-1"}),
        );

        let (events, truncated) = hub.resume_after_chat(0, Some("cid-a"), None);
        assert!(!truncated);
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|ev| ev.method.starts_with("chat.")));
        assert!(events
            .iter()
            .all(|ev| ev.conversation_id.as_deref() == Some("cid-a")));
    }

    #[test]
    fn tail_chat_returns_latest_events_per_conversation() {
        let hub = Hub::new(16);
        for i in 0..5 {
            hub.broadcast(
                "chat.message.delta".into(),
                json!({"conversationId":"cid-c","provider":"codex","delta": format!("{}", i)}),
            );
        }
        hub.broadcast(
            "chat.message.completed".into(),
            json!({"conversationId":"cid-c","provider":"codex","text":"done"}),
        );

        let events = hub.tail_chat(Some("cid-c"), None, 3);
        assert_eq!(events.len(), 3);
        assert_eq!(
            events
                .first()
                .and_then(|e| e.params.get("delta"))
                .and_then(|v| v.as_str()),
            Some("3")
        );
        assert_eq!(
            events
                .last()
                .and_then(|e| e.method.as_str().strip_prefix("chat.")),
            Some("message.completed")
        );
    }

    #[test]
    fn resume_after_chat_filters_by_conversation_and_provider() {
        let hub = Hub::new(16);
        // same conversation, different providers
        hub.broadcast(
            "chat.message.delta".into(),
            json!({"conversationId":"cid-z","provider":"codex","delta":"x"}),
        );
        hub.broadcast(
            "chat.message.delta".into(),
            json!({"conversationId":"cid-z","provider":"other","delta":"y"}),
        );
        let (only_codex, truncated) = hub.resume_after_chat(0, Some("cid-z"), Some("codex"));
        assert!(!truncated);
        assert_eq!(only_codex.len(), 1);
        let ev = &only_codex[0];
        assert_eq!(ev.params.get("delta").and_then(|v| v.as_str()), Some("x"));
        assert_eq!(ev.provider_id.as_deref(), Some("codex"));
    }
}
