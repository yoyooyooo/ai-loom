use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Serialize)]
pub struct WsSubSnapshot {
    pub token: String,
    pub ref_count: u32,
    pub topic: String,
    pub filter: serde_json::Value,
}

#[derive(Clone, Serialize)]
pub struct WsConnSnapshot {
    pub conn_id: u64,
    pub subs: Vec<WsSubSnapshot>,
}

static WS_SNAPSHOT: Lazy<Mutex<HashMap<u64, Vec<(String, u32)>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn set_conn_subs(conn_id: u64, items: Vec<(String, u32)>) {
    if let Ok(mut guard) = WS_SNAPSHOT.lock() {
        guard.insert(conn_id, items);
    }
}

pub fn remove_conn(conn_id: u64) {
    if let Ok(mut guard) = WS_SNAPSHOT.lock() {
        guard.remove(&conn_id);
    }
}

pub fn snapshot() -> Vec<WsConnSnapshot> {
    let guard = match WS_SNAPSHOT.lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    guard
        .iter()
        .map(|(cid, list)| WsConnSnapshot {
            conn_id: *cid,
            subs: list
                .iter()
                .map(|(token, rc)| {
                    let (topic, filter) = parse_token(token);
                    WsSubSnapshot {
                        token: token.clone(),
                        ref_count: *rc,
                        topic,
                        filter,
                    }
                })
                .collect(),
        })
        .collect()
}

fn parse_token(token: &str) -> (String, serde_json::Value) {
    let mut parts = token.splitn(2, ':');
    let topic = parts.next().unwrap_or("").to_string();
    let rest = parts.next().unwrap_or("");
    let filter = serde_json::from_str::<serde_json::Value>(rest).unwrap_or(serde_json::json!({}));
    (topic, filter)
}
