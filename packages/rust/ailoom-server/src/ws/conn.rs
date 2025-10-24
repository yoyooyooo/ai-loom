use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::Notify;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

use crate::{
    state::AppState,
    ws::{
        config::WsConfig,
        hub::{Event, Hub},
        protocol::{RpcNotification, RpcRequest, RpcResponse},
    },
};

#[derive(Clone)]
struct SubFilter {
    topic: String,
    filter: Value,
}

pub async fn handle_connection(state: AppState, mut socket: WebSocket) {
    let hub_opt: Option<Hub> = state.ws_hub.clone();
    let cfg = WsConfig::from_env();
    let unfiltered = std::env::var("AILOOM_WS_UNFILTERED").unwrap_or_else(|_| "0".into()) == "1";
    static CONN_COUNTER: AtomicU64 = AtomicU64::new(1);
    let conn_id = CONN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let trace = std::env::var("AILOOM_WS_TRACE_CONN").unwrap_or_else(|_| "0".into()) == "1";

    // send welcome（不携带 eventId，避免误推动客户端 lastEventId 导致 resume 丢失业务事件）
    let welcome = RpcNotification {
        jsonrpc: "2.0".into(),
        method: "session.welcome".into(),
        params: Some(json!({
          "serverVersion": env!("APP_VERSION"),
          "features": ["jsonrpc","subscriptions"],
          "limits": {"maxMessageBytes": 6*1024*1024, "requestTimeoutMs": 15_000}
        })),
    };
    let _ = socket
        .send(Message::Text(serde_json::to_string(&welcome).unwrap()))
        .await;
    if trace {
        tracing::info!(target:"ws", conn=%conn_id, "welcome sent");
    }

    // subscriptions: token -> SubFilter
    let subs: Arc<tokio::sync::RwLock<HashMap<String, SubFilter>>> =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    let mut last_pong = std::time::Instant::now();
    let closed_flag = Arc::new(AtomicBool::new(false));
    let shutdown = Arc::new(Notify::new());
    // 自愈度量：最近一次“业务类事件”（file/tree/annotations/resync）入队 & 成功写出的时间
    let last_biz_enqueued_ms = Arc::new(AtomicU64::new(0));
    let last_biz_write_ok_ms = Arc::new(AtomicU64::new(0));
    // 最近一次成功向该连接写出的“业务事件”的 eventId（forward 线程维护）
    let last_sent_event_id_shared = Arc::new(AtomicU64::new(0));

    // Hub receiver handled by forward task; no extra subscribe here to avoid ghost receivers

    // split socket for send/recv
    let (mut sender, mut receiver) = socket.split();
    // 单写者 + 双通道（优先 + 文件事件 + 树事件）
    let (priority_tx, mut priority_rx) = tokio::sync::mpsc::channel::<String>(64);
    let (events_file_tx, mut events_file_rx) = tokio::sync::mpsc::channel::<String>(256);
    let (events_tree_tx, mut events_tree_rx) = tokio::sync::watch::channel::<Option<String>>(None);

    // single send loop
    let closed_for_send = closed_flag.clone();
    let shutdown_for_send = shutdown.clone();
    // 默认 1000ms：更快触发 close-first + resume 纠偏；如需更保守可通过 env 提升
    let send_timeout_ms: u64 = cfg.send_timeout_ms;
    let last_biz_write_ok_ms_for_send = last_biz_write_ok_ms.clone();
    let last_sent_event_id_for_send = last_sent_event_id_shared.clone();
    let writer_task = tokio::spawn(async move {
        loop {
            tokio::select! {
              biased;
              // 优先处理优先队列
              maybe = priority_rx.recv() => {
                if let Some(txt) = maybe {
                  let mut parsed_method: Option<String> = None;
                  let mut parsed_event_id: Option<u64> = None;
                  if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                    if let Some(m) = v.get("method").and_then(|x| x.as_str()) { parsed_method = Some(m.to_string()); }
                    if let Some(p) = v.get("params") {
                      if let Some(eid) = p.get("eventId").and_then(|x| x.as_str()).and_then(|s| s.parse::<u64>().ok()) { parsed_event_id = Some(eid); }
                      else if let Some(eid) = p.get("eventId").and_then(|x| x.as_u64()) { parsed_event_id = Some(eid); }
                    }
                  }
                  let is_biz = match parsed_method.as_deref() {
                    Some("file.changed") | Some("tree.changed") | Some("session.resync") => true,
                    Some(m) if m.starts_with("annotations.") => true,
                    _ => false,
                  };
                  let size = txt.len();
                  let res = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.send(Message::Text(txt))).await;
                  match res {
                    Ok(Ok(())) => {
                      let fr = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.flush()).await;
                      if fr.is_err() {
                        let meth = parsed_method.clone().unwrap_or_else(|| "".into());
                        tracing::warn!(target: "ws", method=%meth, size=%size, timeout_ms=%send_timeout_ms, "flush timeout, closing");
                        let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await;
                        closed_for_send.store(true, Ordering::Relaxed);
                        shutdown_for_send.notify_waiters();
                        break;
                      }
                      if is_biz {
                        let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64 / 1_000_000;
                        last_biz_write_ok_ms_for_send.store(now, Ordering::Relaxed);
                        if let Some(eid) = parsed_event_id { last_sent_event_id_for_send.store(eid, Ordering::Relaxed); }
                        if let Some(m) = parsed_method.as_deref() { tracing::info!(target: "ws", method=%m, event_id=?parsed_event_id, "write ok"); }
                      }
                    }
                    _ => {
                      let meth = parsed_method.unwrap_or_else(|| "".into());
                      tracing::warn!(target: "ws", method=%meth, size=%size, timeout_ms=%send_timeout_ms, "send timeout or error, closing");
                      let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await;
                      closed_for_send.store(true, Ordering::Relaxed);
                      shutdown_for_send.notify_waiters();
                      break;
                    }
                  }
                } else { break; }
              }
              // 文件事件队列（不可丢失）
              ev = events_file_rx.recv() => {
                if let Some(txt) = ev {
                  let mut parsed_method: Option<String> = None;
                  let mut parsed_event_id: Option<u64> = None;
                  if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                    if let Some(m) = v.get("method").and_then(|x| x.as_str()) { parsed_method = Some(m.to_string()); }
                    if let Some(p) = v.get("params") {
                      if let Some(eid) = p.get("eventId").and_then(|x| x.as_str()).and_then(|s| s.parse::<u64>().ok()) { parsed_event_id = Some(eid); }
                      else if let Some(eid) = p.get("eventId").and_then(|x| x.as_u64()) { parsed_event_id = Some(eid); }
                    }
                  }
                  let is_biz = match parsed_method.as_deref() {
                    Some("file.changed") | Some("tree.changed") | Some("session.resync") => true,
                    Some(m) if m.starts_with("annotations.") => true,
                    _ => false,
                  };
                  let size = txt.len();
                  let res = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.send(Message::Text(txt))).await;
                  match res {
                    Ok(Ok(())) => {
                      let fr = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.flush()).await;
                      if fr.is_err() {
                        let meth = parsed_method.clone().unwrap_or_else(|| "".into());
                        tracing::warn!(target: "ws", method=%meth, size=%size, timeout_ms=%send_timeout_ms, "flush timeout, closing");
                        let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await;
                        closed_for_send.store(true, Ordering::Relaxed);
                        shutdown_for_send.notify_waiters();
                        break;
                      }
                      if is_biz {
                        let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64 / 1_000_000;
                        last_biz_write_ok_ms_for_send.store(now, Ordering::Relaxed);
                        if let Some(eid) = parsed_event_id { last_sent_event_id_for_send.store(eid, Ordering::Relaxed); }
                        if let Some(m) = parsed_method.as_deref() { tracing::info!(target: "ws", method=%m, event_id=?parsed_event_id, "write ok"); }
                      }
                    }
                    _ => {
                      let meth = parsed_method.unwrap_or_else(|| "".into());
                      tracing::warn!(target:"ws", method=%meth, size=%size, timeout_ms=%send_timeout_ms, "send timeout or error, closing");
                      let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await;
                      closed_for_send.store(true, Ordering::Relaxed);
                      shutdown_for_send.notify_waiters();
                      break;
                    }
                  }
                }
              }
              // 树事件（keep latest）
              _ = events_tree_rx.changed() => {
                let txt_opt = { events_tree_rx.borrow().clone() };
                if let Some(txt) = txt_opt {
                  let mut parsed_method: Option<String> = None;
                  let mut parsed_event_id: Option<u64> = None;
                  if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                    if let Some(m) = v.get("method").and_then(|x| x.as_str()) { parsed_method = Some(m.to_string()); }
                    if let Some(p) = v.get("params") {
                      if let Some(eid) = p.get("eventId").and_then(|x| x.as_str()).and_then(|s| s.parse::<u64>().ok()) { parsed_event_id = Some(eid); }
                      else if let Some(eid) = p.get("eventId").and_then(|x| x.as_u64()) { parsed_event_id = Some(eid); }
                    }
                  }
                  let is_biz = match parsed_method.as_deref() {
                    Some("file.changed") | Some("tree.changed") | Some("session.resync") => true,
                    Some(m) if m.starts_with("annotations.") => true,
                    _ => false,
                  };
                  let size = txt.len();
                  let res = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.send(Message::Text(txt))).await;
                  match res {
                    Ok(Ok(())) => {
                      let fr = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.flush()).await;
                      if fr.is_err() {
                        let meth = parsed_method.clone().unwrap_or_else(|| "".into());
                        tracing::warn!(target: "ws", method=%meth, size=%size, timeout_ms=%send_timeout_ms, "flush timeout, closing");
                        let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await;
                        closed_for_send.store(true, Ordering::Relaxed);
                        shutdown_for_send.notify_waiters();
                        break;
                      }
                      if is_biz {
                        let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64 / 1_000_000;
                        last_biz_write_ok_ms_for_send.store(now, Ordering::Relaxed);
                        if let Some(eid) = parsed_event_id { last_sent_event_id_for_send.store(eid, Ordering::Relaxed); }
                        if let Some(m) = parsed_method.as_deref() { tracing::info!(target: "ws", method=%m, event_id=?parsed_event_id, "write ok"); }
                      }
                    }
                    _ => {
                      let meth = parsed_method.unwrap_or_else(|| "".into());
                      tracing::warn!(target: "ws", method=%meth, size=%size, timeout_ms=%send_timeout_ms, "send timeout or error, closing");
                      let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await;
                      closed_for_send.store(true, Ordering::Relaxed);
                      shutdown_for_send.notify_waiters();
                      break;
                    }
                  }
                }
              }
              _ = shutdown_for_send.notified() => { break; }
            }
        }
    });

    // forward hub events：文件走队列、树走 keep-latest、其他走优先通道
    let events_file_tx_hub = events_file_tx.clone();
    let events_tree_tx_hub = events_tree_tx.clone();
    let priority_tx_fwd = priority_tx.clone();
    let subs_for_fwd = subs.clone();
    let hub_for_fwd = hub_opt.clone();
    let closed_for_fwd = closed_flag.clone();
    let last_biz_enqueued_ms_for_fwd = last_biz_enqueued_ms.clone();
    let last_sent_event_id_for_fwd = last_sent_event_id_shared.clone();
    // no backlog metrics in latest-wins path
    let forward_task = tokio::spawn(async move {
        let Some(hub_inst) = hub_for_fwd.clone() else {
            return;
        };
        let mut rx = hub_inst.subscribe();
        let mut last_sent_event_id: u64 = 0;
        loop {
            if closed_for_fwd.load(Ordering::Relaxed) {
                break;
            }
            match rx.recv().await {
                Ok(ev) => {
                    let mut allowed = {
                        let guard = subs_for_fwd.read().await;
                        subs_match_any(&*guard, &ev)
                    };
                    if ev.method == "session.stats"
                        || ev.method == "file.changed"
                        || ev.method == "tree.changed"
                        || ev.method == "session.resync"
                        || ev.method.starts_with("chat.")
                        || unfiltered
                    {
                        allowed = true;
                    }
                    if !allowed {
                        continue;
                    }
                    if ev.method == "file.changed"
                        || ev.method == "tree.changed"
                        || ev.method.starts_with("annotations.")
                        || ev.method == "session.resync"
                    {
                        let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64
                            / 1_000_000;
                        last_biz_enqueued_ms_for_fwd.store(now, Ordering::Relaxed);
                    }
                    // 注意：不要在转发协程中更新 last_sent_event_id_shared（仅在“实际写出成功”后更新）
                    if let Some(eid) = ev
                        .params
                        .get("eventId")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse::<u64>().ok())
                    {
                        if eid > last_sent_event_id {
                            last_sent_event_id = eid;
                        }
                    } else if let Some(eid) = ev.params.get("eventId").and_then(|v| v.as_u64()) {
                        if eid > last_sent_event_id {
                            last_sent_event_id = eid;
                        }
                    }
                    let notif = RpcNotification {
                        jsonrpc: "2.0".into(),
                        method: ev.method.clone(),
                        params: Some(ev.params),
                    };
                    let text = serde_json::to_string(&notif).unwrap();
                    if trace {
                        let eid_dbg = last_sent_event_id;
                        tracing::info!(target:"ws", conn=%conn_id, event_id=%eid_dbg, method=%notif.method, "fwd");
                    }
                    if notif.method == "tree.changed" {
                        let _ = events_tree_tx_hub.send_replace(Some(text));
                    } else if notif.method == "file.changed"
                        || notif.method.starts_with("annotations.")
                        || notif.method == "session.resync"
                    {
                        let _ = events_file_tx_hub.send(text).await;
                    } else {
                        let _ = priority_tx_fwd.send(text).await;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if let Some(hub) = hub_for_fwd.clone() {
                        let after = last_sent_event_id;
                        let (mut events, _truncated) = hub.resume_after(after);
                        if events.is_empty() && after == 0 {
                            let notif = RpcNotification {
                                jsonrpc: "2.0".into(),
                                method: "session.resync".into(),
                                params: Some(json!({"reason":"lagged_initial"})),
                            };
                            let _ = priority_tx_fwd
                                .send(serde_json::to_string(&notif).unwrap())
                                .await;
                        } else if !events.is_empty() {
                            let take = events.len().min(64);
                            events = events.split_off(events.len() - take);
                            for e in events.into_iter() {
                                let mut allowed = {
                                    let guard = subs_for_fwd.read().await;
                                    let ev_tmp = crate::ws::hub::Event {
                                        method: e.method.clone(),
                                        params: e.params.clone(),
                                    };
                                    subs_match_any(&*guard, &ev_tmp)
                                };
                                if e.method == "session.stats"
                                    || e.method == "file.changed"
                                    || e.method == "tree.changed"
                                    || e.method == "session.resync"
                                    || e.method.starts_with("chat.")
                                    || unfiltered
                                {
                                    allowed = true;
                                }
                                if !allowed {
                                    continue;
                                }
                                let notif = RpcNotification {
                                    jsonrpc: "2.0".into(),
                                    method: e.method.clone(),
                                    params: Some(e.params.clone()),
                                };
                                let text = serde_json::to_string(&notif).unwrap();
                                if notif.method == "tree.changed" {
                                    let _ = events_tree_tx_hub.send_replace(Some(text));
                                } else if notif.method == "file.changed"
                                    || notif.method.starts_with("annotations.")
                                    || notif.method == "session.resync"
                                {
                                    let _ = events_file_tx_hub.send(text).await;
                                } else {
                                    let _ = priority_tx_fwd.send(text).await;
                                }
                                if e.id > last_sent_event_id {
                                    last_sent_event_id = e.id;
                                }
                            }
                        }
                    }
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    rx = hub_inst.subscribe();
                    continue;
                }
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    rx = hub_inst.subscribe();
                    continue;
                }
            }
        }
    });

    // 辅助 PUMP：定期从 Hub 的 ring 拉取增量，避免仅依赖 broadcast 推送
    let events_file_tx_pump = events_file_tx.clone();
    let events_tree_tx_pump = events_tree_tx.clone();
    let hub_for_pump = hub_opt.clone();
    let closed_for_pump = closed_flag.clone();
    let subs_for_pump = subs.clone();
    let last_sent_event_id_for_pump = last_sent_event_id_shared.clone();
    let trace_pump = trace;
    let pump_task = tokio::spawn(async move {
        if let Some(hub) = hub_for_pump.clone() {
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if closed_for_pump.load(Ordering::Relaxed) {
                    break;
                }
                let hub_last = hub.stats_snapshot().last_event_id;
                let last_sent = last_sent_event_id_for_pump.load(Ordering::Relaxed);
                if hub_last <= last_sent {
                    continue;
                }
                let (mut events, _truncated) = hub.resume_after(last_sent);
                if events.is_empty() {
                    continue;
                }
                let take = events.len().min(128);
                events = events.split_off(events.len() - take);
                for e in events.into_iter() {
                    if e.id <= last_sent {
                        continue;
                    }
                    let mut allowed = {
                        let guard = subs_for_pump.read().await;
                        let ev_tmp = crate::ws::hub::Event {
                            method: e.method.clone(),
                            params: e.params.clone(),
                        };
                        subs_match_any(&*guard, &ev_tmp)
                    };
                    if e.method == "session.stats"
                        || e.method == "file.changed"
                        || e.method == "tree.changed"
                        || e.method == "session.resync"
                        || e.method.starts_with("chat.")
                        || unfiltered
                    {
                        allowed = true;
                    }
                    if !allowed {
                        continue;
                    }
                    let notif = RpcNotification {
                        jsonrpc: "2.0".into(),
                        method: e.method.clone(),
                        params: Some(e.params.clone()),
                    };
                    let text = serde_json::to_string(&notif).unwrap();
                    if notif.method == "tree.changed" {
                        let _ = events_tree_tx_pump.send_replace(Some(text));
                    } else if notif.method == "file.changed"
                        || notif.method.starts_with("annotations.")
                        || notif.method == "session.resync"
                    {
                        let _ = events_file_tx_pump.send(text).await;
                    } else {
                        // 其它非业务低频通知直接走优先通道，避免误入事件队列（需要克隆优先通道）
                    }
                    if trace_pump {
                        tracing::info!(target:"ws", event_id=%e.id, method=%e.method, "pump");
                    }
                }
            }
        }
    });

    // 自愈：若开启 FORCE_RECOVER，当检测到“有业务事件到达”但“在阈值内未成功写出”，则对该连接发送一次 session.resync 并快速关闭，促使前端重连+resume
    let force_recover = cfg.force_recover;
    let force_recover_ms: u64 = cfg.force_recover_ms;
    if force_recover {
        let priority_tx_recover = priority_tx.clone();
        let closed_for_recover = closed_flag.clone();
        let last_biz_enqueued_ms_chk = last_biz_enqueued_ms.clone();
        let last_biz_write_ok_ms_chk = last_biz_write_ok_ms.clone();
        let shutdown_recover = shutdown.clone();
        let close_first = cfg.recover_close_first;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(300)).await;
                if closed_for_recover.load(Ordering::Relaxed) {
                    break;
                }
                let enq_ms = last_biz_enqueued_ms_chk.load(Ordering::Relaxed);
                if enq_ms == 0 {
                    continue;
                }
                let ok_ms = last_biz_write_ok_ms_chk.load(Ordering::Relaxed);
                if ok_ms >= enq_ms {
                    continue;
                }
                let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64 / 1_000_000;
                if now.saturating_sub(enq_ms) > force_recover_ms {
                    if !close_first {
                        // 兼容旧策略：先尝试发 resync（通过优先 chan）
                        let notif = RpcNotification {
                            jsonrpc: "2.0".into(),
                            method: "session.resync".into(),
                            params: Some(json!({"reason":"force_recover"})),
                        };
                        let _ = priority_tx_recover
                            .send(serde_json::to_string(&notif).unwrap())
                            .await;
                    }
                    closed_for_recover.store(true, Ordering::Relaxed);
                    // 立即唤醒，尽快退出读循环；发送协程会因通道关闭或后续错误而退出
                    shutdown_recover.notify_waiters();
                    if trace {
                        tracing::info!(target:"ws", conn=%conn_id, close_first=%close_first, "force_recover: close connection");
                    }
                    break;
                }
            }
        });
    }

    // 连接监督器：即便 forward 协程未收到广播，也能在 Hub 存在更新且本连接长时间无业务写出时强制触发 resync
    let hub_for_super = hub_opt.clone();
    let priority_tx_super = priority_tx.clone();
    let closed_for_super = closed_flag.clone();
    let last_sent_event_id_super = last_sent_event_id_shared.clone();
    let shutdown_for_supervisor = shutdown.clone();
    // 更激进：默认 1000ms；比较 Hub.lastEventId vs 连接“实际已写出”的 lastSentEventId
    let force_recover_ms_super: u64 = cfg.force_recover_ms;
    let enable_supervisor = cfg.supervisor_enabled; // dev 默认开启
    if enable_supervisor {
        tokio::spawn(async move {
            if let Some(hub) = hub_for_super.clone() {
                let shutdown_super = shutdown_for_supervisor;
                let close_first = std::env::var("AILOOM_WS_RECOVER_CLOSE_FIRST")
                    .unwrap_or_else(|_| "1".into())
                    == "1";
                loop {
                    tokio::time::sleep(Duration::from_millis(cfg.pump_ms.min(300))).await;
                    if closed_for_super.load(Ordering::Relaxed) {
                        break;
                    }
                    let hub_last = hub.stats_snapshot().last_event_id;
                    let conn_last = last_sent_event_id_super.load(Ordering::Relaxed);
                    if hub_last <= conn_last {
                        continue;
                    }
                    // 本连接落后于 Hub；给它一个窗口（force_recover_ms_super）让其写出；若超时仍未追上，则下发 resync
                    let deadline = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64
                        / 1_000_000
                        + force_recover_ms_super;
                    // 简单等待窗口
                    tokio::time::sleep(Duration::from_millis(force_recover_ms_super.min(400)))
                        .await;
                    if closed_for_super.load(Ordering::Relaxed) {
                        break;
                    }
                    let conn_after = last_sent_event_id_super.load(Ordering::Relaxed);
                    let now_ms =
                        time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64 / 1_000_000;
                    if hub_last > conn_after && now_ms >= deadline {
                        if !close_first {
                            let notif = RpcNotification {
                                jsonrpc: "2.0".into(),
                                method: "session.resync".into(),
                                params: Some(json!({"reason":"supervisor"})),
                            };
                            let _ = priority_tx_super
                                .send(serde_json::to_string(&notif).unwrap())
                                .await;
                        }
                        // 标记关闭并唤醒各循环，加速断开重连
                        closed_for_super.store(true, Ordering::Relaxed);
                        shutdown_super.notify_waiters();
                        // supervisor 场景下打印关键游标对比
                        if trace {
                            tracing::info!(target:"ws", conn=%conn_id, hub_last=%hub_last, conn_last=%conn_after, close_first=%close_first, "supervisor: close connection");
                        }
                        break;
                    }
                }
            }
        });
    }

    // ping loop
    let out_tx_ping = priority_tx.clone();
    let ping_task = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let notif = RpcNotification {
                jsonrpc: "2.0".into(),
                method: "session.ping".into(),
                params: Some(
                    json!({"ts": time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_else(|_| "".into())}),
                ),
            };
            let _ = out_tx_ping
                .send(serde_json::to_string(&notif).unwrap())
                .await;
        }
    });

    // read loop
    loop {
        let next_msg = receiver.next();
        tokio::select! {
          _ = shutdown.notified() => { break; }
          maybe = next_msg => {
            if closed_flag.load(Ordering::Relaxed) { break; }
            match maybe {
              Some(Ok(msg)) => {
                match msg {
                  Message::Text(txt) => {
            // could be request or notification
            // try parse request
            if let Ok(req) = serde_json::from_str::<RpcRequest>(&txt) {
              if let Some(id) = req.id.clone() {
                // request with id
                let started = std::time::Instant::now();
                let method_name = req.method.clone();
                let resp = handle_request(&state, &subs, req).await;
                let elapsed = started.elapsed().as_millis() as u64;
                if resp.error.is_some() {
                  tracing::info!(target: "ws", method=%method_name, ok=false, ms=%elapsed);
                } else {
                  tracing::info!(target: "ws", method=%method_name, ok=true, ms=%elapsed);
                }
                if trace { tracing::info!(target:"ws", conn=%conn_id, method=%method_name, "rpc"); }
                let _ = priority_tx.send(serde_json::to_string(&resp).unwrap()).await;
              } else {
                // notification
                if req.method == "session.pong" { last_pong = std::time::Instant::now(); }
              }
            } else if let Ok(notif) = serde_json::from_str::<RpcNotification>(&txt) {
              if notif.method == "session.pong" { last_pong = std::time::Instant::now(); }
            }
                  }
                  Message::Close(_) => break,
                  Message::Ping(_) => { /* ignore, browser WS stack handles */ }
                  _ => {}
                }
                // disconnect if pong timeout
                if last_pong.elapsed() > Duration::from_secs(65) { break; }
              }
              _ => break,
            }
          }
        }
    }

    // cleanup
    let _ = forward_task.abort();
    let _ = ping_task.abort();
    let _ = writer_task.abort();
    let _ = pump_task.abort();
    tracing::info!(target: "ws", conn=%conn_id, "connection closed");
}

fn normalize_filter(filter: &Value) -> String {
    // Sort object keys shallowly using BTreeMap for stable token
    if let Some(obj) = filter.as_object() {
        let mut map = std::collections::BTreeMap::new();
        for (k, v) in obj.iter() {
            map.insert(k.clone(), v.clone());
        }
        serde_json::to_string(&map).unwrap_or_else(|_| "{}".into())
    } else {
        filter.to_string()
    }
}

fn subs_match_any(subs: &HashMap<String, SubFilter>, ev: &Event) -> bool {
    for (_t, s) in subs.iter() {
        if s.topic == "file" && ev.method == "file.changed" {
            if let Some(p) = ev.params.get("path").and_then(|v| v.as_str()) {
                let f = &s.filter;
                if let Some(pp) = f.get("path").and_then(|v| v.as_str()) {
                    if pp == p {
                        return true;
                    }
                }
                if let Some(pref) = f.get("prefix").and_then(|v| v.as_str()) {
                    if p.starts_with(pref) {
                        return true;
                    }
                }
            }
        } else if s.topic == "tree" && ev.method == "tree.changed" {
            // if filter.dir matches or empty
            let want = s.filter.get("dir").and_then(|v| v.as_str()).unwrap_or("");
            if want.is_empty() {
                return true;
            }
            if let Some(dir) = ev.params.get("dir").and_then(|v| v.as_str()) {
                if dir == want {
                    return true;
                }
            }
            if let Some(imps) = ev.params.get("impactedPaths").and_then(|v| v.as_array()) {
                for it in imps {
                    if let Some(pp) = it.as_str() {
                        if pp.starts_with(&(want.to_string() + "/")) || pp == want {
                            return true;
                        }
                    }
                }
            }
        } else if s.topic == "annotations" && ev.method.starts_with("annotations.") {
            let want = s.filter.get("filePath").and_then(|v| v.as_str());
            if want.is_none() {
                return true;
            }
            let wantp = want.unwrap();
            if ev.method == "annotations.deleted" {
                return true;
            }
            if let Some(obj) = ev.params.get("annotation").and_then(|v| v.as_object()) {
                if let Some(fp) = obj.get("filePath").and_then(|v| v.as_str()) {
                    if fp == wantp {
                        return true;
                    }
                }
            }
        } else if s.topic == "chat"
            && (ev.method.starts_with("chat.") || ev.method.starts_with("codex/"))
        {
            let want = s.filter.get("conversationId").and_then(|v| v.as_str());
            if want.is_none() {
                return true;
            }
            let params_id = ev.params.get("conversationId").and_then(|v| v.as_str());
            if params_id.is_none() {
                continue;
            }
            if params_id == want {
                return true;
            }
        }
    }
    false
}

async fn handle_request(
    state: &AppState,
    subs: &Arc<tokio::sync::RwLock<HashMap<String, SubFilter>>>,
    req: RpcRequest,
) -> RpcResponse {
    let id = req.id.unwrap_or(json!(null));
    let params = req.params.unwrap_or(json!({}));
    match req.method.as_str() {
        "subscribe" => {
            let topic = params.get("topic").and_then(|v| v.as_str()).unwrap_or("");
            let filter = params.get("filter").cloned().unwrap_or(json!({}));
            if topic.is_empty() {
                return RpcResponse::err(id, "INVALID_PARAMS", "topic required", None);
            }
            let token = format!("{}:{}", topic, normalize_filter(&filter));
            {
                let mut guard = subs.write().await;
                guard.entry(token.clone()).or_insert(SubFilter {
                    topic: topic.to_string(),
                    filter,
                });
            }
            RpcResponse::ok(id, json!({"token": token}))
        }
        "unsubscribe" => {
            let tok = params.get("token").and_then(|v| v.as_str());
            if let Some(t) = tok {
                let mut guard = subs.write().await;
                guard.remove(t);
            }
            RpcResponse::ok(id, json!({"ok": true}))
        }
        m => {
            match super::methods::call(m, &params, state).await {
                Ok(v) => RpcResponse::ok(id, v),
                Err(e) => {
                    // map anyhow("CODE:msg")
                    let s = e.to_string();
                    let (code, msg) = s.split_once(':').unwrap_or(("INTERNAL", s.as_str()));
                    RpcResponse::err(id, code, msg, None)
                }
            }
        }
    }
}
