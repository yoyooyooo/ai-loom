use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::Notify;
use tokio::time::MissedTickBehavior;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

use crate::services::codex::bridge::active_conversation_ids;
use crate::ws::gating_log;
use crate::ws::inspect;
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
    // 引用计数：同一连接、相同 topic+filter 的多次订阅会合并为一条，直到计数归零才真正移除
    ref_count: u32,
    // 退订宽限期版本号：每次从 >0 → 0 时递增；用于延时移除时校验是否仍为同一代
    zero_gen: u64,
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
    // 初始化连接快照（空订阅）
    inspect::set_conn_subs(conn_id, Vec::new());

    // 断线重连 Watchdog：WS 新连接建立后，短窗内为活跃中的会话做一次监听保障
    // 默认关闭连接级 watchdog；如需启用，显式设置 AILOOM_WS_CONN_WATCHDOG=1
    if std::env::var("AILOOM_WS_CONN_WATCHDOG").unwrap_or_else(|_| "0".into()) != "0" {
        let hub_for_watchdog = hub_opt.clone();
        let workspace_root = state.workspace_root.clone();
        // 延迟时间可配置，默认更保守（1800ms）
        let delay_ms: u64 = std::env::var("AILOOM_WS_CONN_WATCHDOG_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(1800);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let ids = active_conversation_ids();
            if ids.is_empty() {
                return;
            }
            // 每会话子进程：逐会话 ensure_listener（必要时内部 resume 并建立监听）
            for cid in ids {
                // 仅对进行中的会话，且最近无事件（>delay_ms）触发保障
                if let Some(h) = hub_for_watchdog.clone() {
                    if h.get_in_progress(&cid) != Some(true) {
                        continue;
                    }
                    if let Some(ts) = h.last_event_ts_for_conversation(&cid) {
                        if let Ok(t) = time::OffsetDateTime::parse(
                            &ts,
                            &time::format_description::well_known::Rfc3339,
                        ) {
                            let now = time::OffsetDateTime::now_utc();
                            if (now - t) < time::Duration::milliseconds(delay_ms as i64) {
                                continue;
                            }
                        }
                    }
                }
                let _ = crate::services::codex::registry::ensure_listener(
                    workspace_root.clone(),
                    hub_for_watchdog.clone(),
                    &cid,
                )
                .await;
                tracing::info!(target:"codex", conversationId=%cid, "ws-conn watchdog: ensure_listener (per-conv)");
            }
        });
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
    // 仅用于 pump 的“已扫描到的最大 eventId”，与“已成功写出”的游标解耦，避免因 gating 导致的重复扫描
    let last_pump_scanned_event_id = Arc::new(AtomicU64::new(0));

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
        // 微批与空闲 flush：聚合一定数量或定时刷新，降低每条 flush 带来的抖动
        let mut pending_since_last_flush: u32 = 0;
        let mut consecutive_flush_timeouts: u32 = 0;
        let mut flush_tick = tokio::time::interval(Duration::from_millis(50));
        flush_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        // 正式化写出配额：live/file 每轮最大直写条数（不含 flush 合并），可通过环境变量调整
        let live_quota: u32 = std::env::var("AILOOM_WS_WRITER_LIVE_QUOTA")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(16);
        let file_quota: u32 = std::env::var("AILOOM_WS_WRITER_FILE_QUOTA")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(16);
        loop {
            tokio::select! {
              // 优先处理优先队列（本次拿到 1 条后，额外 try_recv 若干条，形成配额，避免独占）
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
                      pending_since_last_flush = pending_since_last_flush.saturating_add(1);
                      if pending_since_last_flush >= 16 {
                        let fr = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.flush()).await;
                        if fr.is_err() {
                          consecutive_flush_timeouts = consecutive_flush_timeouts.saturating_add(1);
                          if consecutive_flush_timeouts >= 3 {
                            let meth = parsed_method.clone().unwrap_or_else(|| "".into());
                            tracing::warn!(target: "ws", method=%meth, size=%size, timeout_ms=%send_timeout_ms, "flush timeout x3, closing");
                            let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await;
                            closed_for_send.store(true, Ordering::Relaxed);
                            shutdown_for_send.notify_waiters();
                            break;
                          }
                        } else {
                          consecutive_flush_timeouts = 0;
                          pending_since_last_flush = 0;
                        }
                      }
                      // 无论业务/聊天类事件，成功写出后都推进 last_sent_event_id，用于 supervisor 与泵判定
                      if let Some(eid) = parsed_event_id { last_sent_event_id_for_send.store(eid, Ordering::Relaxed); }
                      // 仅业务类事件计入“业务写出 OK”时间与摘要日志
                      if is_biz {
                        let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64 / 1_000_000;
                        last_biz_write_ok_ms_for_send.store(now, Ordering::Relaxed);
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
                  // 额外尝试在本轮内多拿一些优先队列（形成配额，随后让出给其他通道）
                  let mut quota_left: u32 = live_quota.saturating_sub(1);
                  while quota_left > 0 {
                    match priority_rx.try_recv() {
                      Ok(txt2) => {
                        let mut parsed_method: Option<String> = None;
                        let mut parsed_event_id: Option<u64> = None;
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt2) {
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
                        let _size2 = txt2.len();
                        let res2 = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.send(Message::Text(txt2))).await;
                        match res2 {
                          Ok(Ok(())) => {
                            pending_since_last_flush = pending_since_last_flush.saturating_add(1);
                            if pending_since_last_flush >= 16 {
                              let fr = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.flush()).await;
                              if fr.is_err() {
                                consecutive_flush_timeouts = consecutive_flush_timeouts.saturating_add(1);
                                if consecutive_flush_timeouts >= 3 { let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await; closed_for_send.store(true, Ordering::Relaxed); shutdown_for_send.notify_waiters(); break; }
                              } else { consecutive_flush_timeouts = 0; pending_since_last_flush = 0; }
                            }
                            if let Some(eid) = parsed_event_id { last_sent_event_id_for_send.store(eid, Ordering::Relaxed); }
                            if is_biz {
                              let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64 / 1_000_000;
                              last_biz_write_ok_ms_for_send.store(now, Ordering::Relaxed);
                            }
                          }
                          _ => { let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await; closed_for_send.store(true, Ordering::Relaxed); shutdown_for_send.notify_waiters(); break; }
                        }
                        quota_left -= 1;
                      }
                      Err(_) => break,
                    }
                  }
                } else { break; }
              }
              // 文件事件队列（不可丢失，配额化 drain）
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
                      pending_since_last_flush = pending_since_last_flush.saturating_add(1);
                      if pending_since_last_flush >= 16 {
                        let fr = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.flush()).await;
                        if fr.is_err() {
                          consecutive_flush_timeouts = consecutive_flush_timeouts.saturating_add(1);
                          if consecutive_flush_timeouts >= 3 {
                            let meth = parsed_method.clone().unwrap_or_else(|| "".into());
                            tracing::warn!(target: "ws", method=%meth, size=%size, timeout_ms=%send_timeout_ms, "flush timeout x3, closing");
                            let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await;
                            closed_for_send.store(true, Ordering::Relaxed);
                            shutdown_for_send.notify_waiters();
                            break;
                          }
                        } else {
                          consecutive_flush_timeouts = 0;
                          pending_since_last_flush = 0;
                        }
                      }
                      // 树类事件同样推进“最后成功写出的 eventId”，用于与 Hub 比较
                      if let Some(eid) = parsed_event_id { last_sent_event_id_for_send.store(eid, Ordering::Relaxed); }
                      if is_biz {
                        let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64 / 1_000_000;
                        last_biz_write_ok_ms_for_send.store(now, Ordering::Relaxed);
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
                  // 额外配额 drain
                  let mut quota_left: u32 = file_quota.saturating_sub(1);
                  while quota_left > 0 {
                    match events_file_rx.try_recv() {
                      Ok(txt2) => {
                        let mut parsed_method: Option<String> = None;
                        let mut parsed_event_id: Option<u64> = None;
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt2) {
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
                        let _size2 = txt2.len();
                        let res2 = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.send(Message::Text(txt2))).await;
                        match res2 {
                          Ok(Ok(())) => {
                            pending_since_last_flush = pending_since_last_flush.saturating_add(1);
                            if pending_since_last_flush >= 16 {
                              let fr = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.flush()).await;
                              if fr.is_err() {
                                consecutive_flush_timeouts = consecutive_flush_timeouts.saturating_add(1);
                                if consecutive_flush_timeouts >= 3 { let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await; closed_for_send.store(true, Ordering::Relaxed); shutdown_for_send.notify_waiters(); break; }
                              } else { consecutive_flush_timeouts = 0; pending_since_last_flush = 0; }
                            }
                            if is_biz {
                              let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64 / 1_000_000;
                              last_biz_write_ok_ms_for_send.store(now, Ordering::Relaxed);
                              if let Some(eid) = parsed_event_id { last_sent_event_id_for_send.store(eid, Ordering::Relaxed); }
                            }
                          }
                          _ => { let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await; closed_for_send.store(true, Ordering::Relaxed); shutdown_for_send.notify_waiters(); break; }
                        }
                        quota_left -= 1;
                      }
                      Err(_) => break,
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
                      pending_since_last_flush = pending_since_last_flush.saturating_add(1);
                      if pending_since_last_flush >= 16 {
                        let fr = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.flush()).await;
                        if fr.is_err() {
                          consecutive_flush_timeouts = consecutive_flush_timeouts.saturating_add(1);
                          if consecutive_flush_timeouts >= 3 {
                            let meth = parsed_method.clone().unwrap_or_else(|| "".into());
                            tracing::warn!(target: "ws", method=%meth, size=%size, timeout_ms=%send_timeout_ms, "flush timeout x3, closing");
                            let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await;
                            closed_for_send.store(true, Ordering::Relaxed);
                            shutdown_for_send.notify_waiters();
                            break;
                          }
                        } else {
                          consecutive_flush_timeouts = 0;
                          pending_since_last_flush = 0;
                        }
                      }
                      // 优先队列事件（含 chat.*）也推进 eventId 光标
                      if let Some(eid) = parsed_event_id { last_sent_event_id_for_send.store(eid, Ordering::Relaxed); }
                      if is_biz {
                        let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u64 / 1_000_000;
                        last_biz_write_ok_ms_for_send.store(now, Ordering::Relaxed);
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
              // 定时 flush：避免长时间积压不刷出
              _ = flush_tick.tick() => {
                if pending_since_last_flush > 0 {
                  let fr = tokio::time::timeout(Duration::from_millis(send_timeout_ms), sender.flush()).await;
                  if fr.is_err() {
                    consecutive_flush_timeouts = consecutive_flush_timeouts.saturating_add(1);
                    if consecutive_flush_timeouts >= 3 {
                      tracing::warn!(target: "ws", size=?pending_since_last_flush, timeout_ms=%send_timeout_ms, "periodic flush timeout x3, closing");
                      let _ = tokio::time::timeout(Duration::from_millis(100), sender.close()).await;
                      closed_for_send.store(true, Ordering::Relaxed);
                      shutdown_for_send.notify_waiters();
                      break;
                    }
                  } else {
                    consecutive_flush_timeouts = 0;
                    pending_since_last_flush = 0;
                  }
                }
              }
              _ = shutdown_for_send.notified() => { break; }
            }
        }
        // 退出前尽力 flush 一次
        let _ = tokio::time::timeout(Duration::from_millis(100), sender.flush()).await;
    });

    // forward hub events：文件走队列、树走 keep-latest、其他走优先通道
    let events_file_tx_hub = events_file_tx.clone();
    let events_tree_tx_hub = events_tree_tx.clone();
    let priority_tx_fwd = priority_tx.clone();
    let subs_for_fwd = subs.clone();
    let hub_for_fwd = hub_opt.clone();
    let closed_for_fwd = closed_flag.clone();
    let last_biz_enqueued_ms_for_fwd = last_biz_enqueued_ms.clone();
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
                        || ev.method.starts_with("annotations.")
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
                    if trace && notif.method != "session.stats" {
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
    let last_scanned_for_pump = last_pump_scanned_event_id.clone();
    let trace_pump = trace;
    let pump_task = tokio::spawn(async move {
        let pump_debug =
            std::env::var("AILOOM_WS_PUMP_DEBUG").unwrap_or_else(|_| "0".into()) == "1";
        if let Some(hub) = hub_for_pump.clone() {
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if closed_for_pump.load(Ordering::Relaxed) {
                    break;
                }
                let hub_last = hub.stats_snapshot().last_event_id;
                let last_sent = last_sent_event_id_for_pump.load(Ordering::Relaxed);
                let last_scanned = last_scanned_for_pump.load(Ordering::Relaxed);
                let after = last_scanned.max(last_sent);
                if hub_last <= after {
                    continue;
                }
                let (mut events, _truncated) = hub.resume_after(after);
                if events.is_empty() {
                    continue;
                }
                let take = events.len().min(128);
                events = events.split_off(events.len() - take);
                let mut max_seen: u64 = after;
                for e in events.into_iter() {
                    if e.id <= after {
                        continue;
                    }
                    if e.id > max_seen {
                        max_seen = e.id;
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
                        || e.method.starts_with("annotations.")
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
                    if trace_pump && pump_debug {
                        tracing::debug!(target:"ws", event_id=%e.id, method=%e.method, "pump");
                    }
                }
                // 标记已扫描到的最大事件，避免在仅包含被 gating 丢弃的事件时重复扫描
                if max_seen > after {
                    last_scanned_for_pump.store(max_seen, Ordering::Relaxed);
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
              if req.id.is_some() {
                // request with id
                let started = std::time::Instant::now();
                let method_name = req.method.clone();
                let resp = handle_request(&state, &subs, req, priority_tx.clone(), &last_sent_event_id_shared, conn_id).await;
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
    // 移除连接调试快照
    inspect::remove_conn(conn_id);
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
    let gating_debug =
        std::env::var("AILOOM_WS_GATING_DEBUG").unwrap_or_else(|_| "0".into()) == "1";
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
    // 未命中：如启用 gating debug，输出一次丢弃原因
    if gating_debug && (ev.method.starts_with("chat.") || ev.method.starts_with("codex/")) {
        let cid = ev
            .params
            .get("conversationId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let use_agg = std::env::var("AILOOM_WS_GATING_AGG").unwrap_or_else(|_| "1".into()) == "1";
        if use_agg {
            gating_log::record(&ev.method, &cid);
            gating_log::maybe_flush();
        } else {
            let tokens: Vec<String> = subs.keys().map(|k| k.clone()).collect();
            tracing::debug!(target = "ws", method=%ev.method, conversation_id=%cid, tokens=?tokens, "gating: chat event dropped (no match)");
        }
    }
    false
}

async fn handle_request(
    state: &AppState,
    subs: &Arc<tokio::sync::RwLock<HashMap<String, SubFilter>>>,
    req: RpcRequest,
    out_priority_tx: tokio::sync::mpsc::Sender<String>,
    last_sent_event_id_shared: &Arc<AtomicU64>,
    conn_id: u64,
) -> RpcResponse {
    let id = req.id.unwrap_or(json!(null));
    let params = req.params.unwrap_or(json!({}));
    match req.method.as_str() {
        "subscribe" => {
            let topic = params.get("topic").and_then(|v| v.as_str()).unwrap_or("");
            let filter = params.get("filter").cloned().unwrap_or(json!({}));
            let filter_dbg = filter.clone();
            if topic.is_empty() {
                return RpcResponse::err(id, "INVALID_PARAMS", "topic required", None);
            }
            let token = format!("{}:{}", topic, normalize_filter(&filter));
            let mut is_new = false;
            {
                let mut guard = subs.write().await;
                if let Some(entry) = guard.get_mut(&token) {
                    // 已存在相同订阅：引用计数 +1
                    entry.ref_count = entry.ref_count.saturating_add(1);
                } else {
                    guard.insert(
                        token.clone(),
                        SubFilter {
                            topic: topic.to_string(),
                            filter,
                            ref_count: 1,
                            zero_gen: 0,
                        },
                    );
                    is_new = true;
                }
            }
            // 更新调试快照（确保不与写锁重叠）
            let items_after: Vec<(String, u32)> = {
                let guard = subs.read().await;
                guard
                    .iter()
                    .map(|(k, v)| (k.clone(), v.ref_count))
                    .collect()
            };
            inspect::set_conn_subs(conn_id, items_after);
            // 订阅即补发（仅 chat 主题；仅在 0->1 首次建立订阅时触发；其它主题暂保持不变）
            if topic == "chat" && is_new {
                let hub = state.ws_hub.clone();
                let tx = out_priority_tx.clone();
                let last_sent = last_sent_event_id_shared.clone();
                let filter_val = filter_dbg.clone();
                let token_clone = token.clone();
                tokio::spawn(async move {
                    let filter_obj = filter_val.as_object().cloned().unwrap_or_default();
                    let filter_conversation_id = filter_obj
                        .get("conversationId")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let filter_provider_id = filter_obj
                        .get("providerId")
                        .or_else(|| filter_obj.get("provider"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    // 不再在订阅时自动 ensure；保持极简，依赖发送/新建链路与 resume 语义

                    // 计算 after/tail（这里沿用调用端入参）
                    let after = params
                        .get("after")
                        .and_then(|v| v.as_u64())
                        .or_else(|| {
                            params
                                .get("after")
                                .and_then(|v| v.as_str())
                                .and_then(|s| s.parse::<u64>().ok())
                        })
                        .unwrap_or(0u64);
                    let tail = params.get("tail").and_then(|v| v.as_u64()).unwrap_or(0u64) as usize;

                    // begin
                    let begin = RpcNotification {
                        jsonrpc: "2.0".into(),
                        method: "chat.session.sync_begin".into(),
                        params: Some(json!({
                            "conversationId": filter_conversation_id,
                            "providerId": filter_provider_id,
                            "after": after,
                            "tail": tail
                        })),
                    };
                    let _ = tx.send(serde_json::to_string(&begin).unwrap()).await;

                    if let Some(h) = hub.clone() {
                        let conv_ref = filter_conversation_id.as_deref();
                        let provider_ref = filter_provider_id.as_deref();
                        let (list, truncated, upto) = if tail > 0 && after == 0 {
                            let events = h.tail_chat(conv_ref, provider_ref, tail);
                            let upto = events.iter().map(|e| e.id).max().unwrap_or(0);
                            (events, false, upto)
                        } else {
                            let (events, truncated) =
                                h.resume_after_chat(after, conv_ref, provider_ref);
                            let upto = events.iter().map(|e| e.id).max().unwrap_or(after);
                            (events, truncated, upto)
                        };
                        let mut __idx: usize = 0;
                        for e in list.into_iter() {
                            let notif = RpcNotification {
                                jsonrpc: "2.0".into(),
                                method: e.method.clone(),
                                params: Some(e.params.clone()),
                            };
                            let _ = tx.send(serde_json::to_string(&notif).unwrap()).await;
                            __idx = __idx.saturating_add(1);
                            if (__idx & 31) == 0 {
                                tokio::task::yield_now().await;
                            }
                            if (__idx % 128) == 0 {
                                tokio::time::sleep(Duration::from_millis(1)).await;
                            }
                        }
                        // waiting upto written (short)
                        let upto_written = {
                            let target = upto;
                            let mut tries = 0u32;
                            loop {
                                let cur = last_sent.load(Ordering::Relaxed);
                                if cur >= target || tries >= 20 {
                                    break cur;
                                }
                                tokio::time::sleep(Duration::from_millis(5)).await;
                                tries = tries.saturating_add(1);
                            }
                        };
                        let upto_final = upto_written.max(after);
                        let end = RpcNotification {
                            jsonrpc: "2.0".into(),
                            method: "chat.session.sync_end".into(),
                            params: Some(json!({
                                "conversationId": filter_conversation_id,
                                "providerId": filter_provider_id,
                                "uptoEventId": upto_final,
                                "truncated": truncated
                            })),
                        };
                        let _ = tx.send(serde_json::to_string(&end).unwrap()).await;
                        tracing::debug!(target = "ws", token = %token_clone, upto = %upto, truncated = %truncated, "subscribe: handshake end");
                    }
                });
            }
            RpcResponse::ok(id, json!({"token": token}))
        }
        "subscribeMany" => {
            let items = params
                .get("items")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if items.is_empty() {
                return RpcResponse::err(id, "INVALID_PARAMS", "items required", None);
            }
            let mut results: Vec<Value> = Vec::with_capacity(items.len());
            // 先处理订阅表与 ref_count，再异步执行握手，避免在请求路径上阻塞
            for it in items.iter() {
                let topic = it.get("topic").and_then(|v| v.as_str()).unwrap_or("");
                let filter = it.get("filter").cloned().unwrap_or(json!({}));
                let filter_dbg = filter.clone();
                if topic.is_empty() {
                    continue;
                }
                let token = format!("{}:{}", topic, normalize_filter(&filter));
                let mut is_new = false;
                {
                    let mut guard = subs.write().await;
                    if let Some(entry) = guard.get_mut(&token) {
                        entry.ref_count = entry.ref_count.saturating_add(1);
                    } else {
                        guard.insert(
                            token.clone(),
                            SubFilter {
                                topic: topic.to_string(),
                                filter: filter.clone(),
                                ref_count: 1,
                                zero_gen: 0,
                            },
                        );
                        is_new = true;
                    }
                }
                // 更新连接快照（不持写锁）
                {
                    let guard = subs.read().await;
                    let items_after: Vec<(String, u32)> = guard
                        .iter()
                        .map(|(k, v)| (k.clone(), v.ref_count))
                        .collect();
                    inspect::set_conn_subs(conn_id, items_after);
                }
                // 订阅即补发：仅 chat & 仅 0->1
                if topic == "chat" && is_new {
                    let hub = state.ws_hub.clone();
                    let tx = out_priority_tx.clone();
                    let last_sent = last_sent_event_id_shared.clone();
                    // 预先提取 after/tail 以免借用 items/it
                    let begin_after_val = it.get("after").cloned().unwrap_or(json!(0));
                    let begin_tail_val = it.get("tail").cloned().unwrap_or(json!(0));
                    let after_u64 = it.get("after").and_then(|v| v.as_u64()).unwrap_or(0u64);
                    let tail_usize =
                        it.get("tail").and_then(|v| v.as_u64()).unwrap_or(0u64) as usize;
                    let filter_to_move = filter.clone();
                    let token_for_log = token.clone();
                    tokio::spawn(async move {
                        let filter_obj = filter_to_move.as_object().cloned().unwrap_or_default();
                        let filter_conversation_id = filter_obj
                            .get("conversationId")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let filter_provider_id = filter_obj
                            .get("providerId")
                            .or_else(|| filter_obj.get("provider"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        // begin
                        let begin = RpcNotification {
                            jsonrpc: "2.0".into(),
                            method: "chat.session.sync_begin".into(),
                            params: Some(json!({
                                "conversationId": filter_conversation_id,
                                "providerId": filter_provider_id,
                                "after": begin_after_val,
                                "tail": begin_tail_val
                            })),
                        };
                        let _ = tx.send(serde_json::to_string(&begin).unwrap()).await;
                        if let Some(h) = hub.clone() {
                            let conv_ref = filter_conversation_id.as_deref();
                            let provider_ref = filter_provider_id.as_deref();
                            let (list, truncated, upto) = if tail_usize > 0 && after_u64 == 0 {
                                let events = h.tail_chat(conv_ref, provider_ref, tail_usize);
                                let upto = events.iter().map(|e| e.id).max().unwrap_or(0);
                                (events, false, upto)
                            } else {
                                let (events, truncated) =
                                    h.resume_after_chat(after_u64, conv_ref, provider_ref);
                                let upto = events.iter().map(|e| e.id).max().unwrap_or(after_u64);
                                (events, truncated, upto)
                            };
                            for e in list.into_iter() {
                                let notif = RpcNotification {
                                    jsonrpc: "2.0".into(),
                                    method: e.method.clone(),
                                    params: Some(e.params.clone()),
                                };
                                let _ = tx.send(serde_json::to_string(&notif).unwrap()).await;
                            }
                            let upto_written = {
                                let target = upto;
                                let mut tries = 0u32;
                                loop {
                                    let cur = last_sent.load(Ordering::Relaxed);
                                    if cur >= target || tries >= 20 {
                                        break cur;
                                    }
                                    tokio::time::sleep(Duration::from_millis(5)).await;
                                    tries = tries.saturating_add(1);
                                }
                            };
                            let end = RpcNotification {
                                jsonrpc: "2.0".into(),
                                method: "chat.session.sync_end".into(),
                                params: Some(json!({
                                    "conversationId": filter_conversation_id,
                                    "providerId": filter_provider_id,
                                    "uptoEventId": upto_written.max(after_u64),
                                    "truncated": truncated
                                })),
                            };
                            let _ = tx.send(serde_json::to_string(&end).unwrap()).await;
                            tracing::debug!(target = "ws", token = %token_for_log, upto = %upto, truncated = %truncated, "subscribeMany: handshake end");
                        }
                    });
                }
                results.push(json!({"token": token}));
            }
            RpcResponse::ok(id, json!({"tokens": results}))
        }
        "unsubscribe" => {
            let tok = params.get("token").and_then(|v| v.as_str());
            if let Some(t) = tok {
                // 先在写锁内更新 ref_count，并准备快照数据，然后释放写锁
                let items_after: Vec<(String, u32)> = {
                    let mut guard = subs.write().await;
                    if let Some(entry) = guard.get_mut(t) {
                        if entry.ref_count > 1 {
                            entry.ref_count -= 1;
                        } else {
                            // 进入退订宽限期：不立刻移除，给快速切换留出窗口
                            entry.ref_count = 0;
                            entry.zero_gen = entry.zero_gen.saturating_add(1);
                            let token_cloned = t.to_string();
                            let subs_for_cleanup = subs.clone();
                            let gen = entry.zero_gen;
                            let grace_ms = std::env::var("AILOOM_WS_UNSUB_GRACE_MS")
                                .ok()
                                .and_then(|s| s.parse::<u64>().ok())
                                .unwrap_or(300);
                            tokio::spawn(async move {
                                tokio::time::sleep(Duration::from_millis(grace_ms)).await;
                                let mut g = subs_for_cleanup.write().await;
                                if let Some(e) = g.get_mut(&token_cloned) {
                                    if e.ref_count == 0 && e.zero_gen == gen {
                                        g.remove(&token_cloned);
                                    }
                                }
                                // 退订宽限结束后更新连接快照
                                {
                                    let items: Vec<(String, u32)> =
                                        g.iter().map(|(k, v)| (k.clone(), v.ref_count)).collect();
                                    inspect::set_conn_subs(conn_id, items);
                                }
                            });
                        }
                    }
                    // 生成快照
                    guard
                        .iter()
                        .map(|(k, v)| (k.clone(), v.ref_count))
                        .collect()
                };
                // 写锁已释放，这里安全更新调试快照
                inspect::set_conn_subs(conn_id, items_after);
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
