use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

static AGG: Lazy<Mutex<GatingAgg>> = Lazy::new(|| {
    Mutex::new(GatingAgg {
        counts: HashMap::new(),
        last_flush: Instant::now(),
    })
});

struct GatingAgg {
    counts: HashMap<(String, String), u64>, // (method, cid) -> count
    last_flush: Instant,
}

impl GatingAgg {
    fn new() -> Self {
        Self {
            counts: HashMap::new(),
            last_flush: Instant::now(),
        }
    }
}

/// 记录一次 gating 丢弃
pub fn record(method: &str, cid: &str) {
    let mut guard = AGG.lock().unwrap();
    let entry = guard
        .counts
        .entry((method.to_string(), cid.to_string()))
        .or_insert(0);
    *entry += 1;
}

/// 若距离上次 flush 超过阈值，则输出聚合摘要并清空
pub fn maybe_flush() {
    let mut guard = AGG.lock().unwrap();
    let now = Instant::now();
    let interval_ms: u64 = std::env::var("AILOOM_WS_GATING_AGG_INTERVAL_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(1000);
    if now.duration_since(guard.last_flush) < Duration::from_millis(interval_ms) {
        return;
    }
    if guard.counts.is_empty() {
        guard.last_flush = now;
        return;
    }
    // 构造简要摘要：按 method 汇总不同 cid 的总次数
    let mut per_method: HashMap<String, u64> = HashMap::new();
    let mut sample: Vec<(String, String, u64)> = Vec::new();
    for ((m, c), n) in guard.counts.iter() {
        *per_method.entry(m.clone()).or_insert(0) += *n;
        if sample.len() < 6 {
            sample.push((m.clone(), c.clone(), *n));
        }
    }
    tracing::debug!(
        target = "ws",
        summary = ?per_method,
        sample = ?sample,
        "gating: aggregated chat/codex events dropped (no match)"
    );
    guard.counts.clear();
    guard.last_flush = now;
}
