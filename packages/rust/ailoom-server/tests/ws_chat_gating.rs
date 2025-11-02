use std::{net::SocketAddr, path::PathBuf, time::Duration};

use ailoom_fs::FsConfig;
use ailoom_server::{router, state::AppState, ws};
use ailoom_store::Store;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

fn tempdir() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "ailoom_ws_test_chat_gating_{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn start_server(root: &PathBuf) -> (SocketAddr, tokio::task::JoinHandle<()>, ws::hub::Hub) {
    let ws_root = root.canonicalize().unwrap();
    let fs_cfg = FsConfig::new(ws_root.clone());
    let db = ws_root.join("ailoom.db");
    let store = Store::connect_path(&db, &ws_root.to_string_lossy())
        .await
        .unwrap();
    let hub = ws::hub::Hub::new(1024);
    let app_state = AppState {
        fs: fs_cfg,
        store,
        root: ws_root.clone(),
        workspace_root: ws_root,
        ws_hub: Some(hub.clone()),
        runtime_registry: ailoom_server::services::executors::registry::RuntimeRegistry::new(),
    };
    let app = router::build_router(app_state, PathBuf::from("packages/web/dist"), true);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let join = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, join, hub)
}

fn parse_json(txt: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(txt).unwrap_or_else(|_| serde_json::json!({}))
}

#[tokio::test]
async fn chat_events_gated_by_subscription() {
    let root = tempdir();
    let (addr, _jh, hub) = start_server(&root).await;

    // connect ws
    let url = format!("ws://{}/ws", addr);
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
    let (mut write, mut read) = ws_stream.split();
    // consume welcome
    let _ = read.next().await;

    // 1) 未订阅 chat 时，广播 chat.* 不应转发到连接
    hub.broadcast(
        "chat.message.completed".into(),
        json!({"conversationId":"cid-gate","provider":"codex","text":"hi"}),
    );
    let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
    let mut got_any_chat = false;
    loop {
        let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
        if timeout.is_zero() {
            break;
        }
        let fut = read.next();
        match tokio::time::timeout(timeout, fut).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v = parse_json(&t);
                if v.get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .starts_with("chat.")
                {
                    got_any_chat = true;
                    break;
                }
            }
            _ => break,
        }
    }
    assert!(
        !got_any_chat,
        "without subscription, chat.* should be gated"
    );

    // 2) 订阅 chat(cID=cid-gate) 之后，收到握手 begin/end
    let sub_req = serde_json::json!({
        "jsonrpc":"2.0", "id":1, "method":"subscribe",
        "params": {"topic":"chat","filter":{"conversationId":"cid-gate"}, "after":0, "tail":1}
    });
    write
        .send(Message::Text(sub_req.to_string()))
        .await
        .unwrap();
    let mut seen_resp1 = false;
    let mut seen_begin = false;
    let mut seen_end = false;
    for _ in 0..5 {
        if let Some(Ok(Message::Text(t))) = read.next().await {
            let v = parse_json(&t);
            if v.get("id").and_then(|x| x.as_i64()) == Some(1) {
                seen_resp1 = true;
            }
            if v.get("method").and_then(|m| m.as_str()) == Some("chat.session.sync_begin") {
                seen_begin = true;
            }
            if v.get("method").and_then(|m| m.as_str()) == Some("chat.session.sync_end") {
                seen_end = true;
            }
            if seen_resp1 && seen_begin && seen_end {
                break;
            }
        }
    }
    assert!(
        seen_resp1 && seen_begin && seen_end,
        "subscribe should respond and handshake"
    );

    // 3) 订阅后广播匹配会话的 chat.* → 应转发
    hub.broadcast(
        "chat.message.completed".into(),
        json!({"conversationId":"cid-gate","provider":"codex","text":"ok"}),
    );
    let mut got_completed = false;
    for _ in 0..10 {
        // up to ~1s
        if let Some(Ok(Message::Text(t))) = read.next().await {
            let v = parse_json(&t);
            if v.get("method").and_then(|m| m.as_str()) == Some("chat.message.completed") {
                got_completed = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        got_completed,
        "matching chat.* should be forwarded after subscribe"
    );

    // 4) 广播不同会话的 chat.* → 不应转发
    hub.broadcast(
        "chat.message.completed".into(),
        json!({"conversationId":"cid-other","provider":"codex","text":"nope"}),
    );
    let deadline2 = tokio::time::Instant::now() + Duration::from_millis(300);
    let mut got_other = false;
    loop {
        let timeout = deadline2.saturating_duration_since(tokio::time::Instant::now());
        if timeout.is_zero() {
            break;
        }
        let fut = read.next();
        match tokio::time::timeout(timeout, fut).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v = parse_json(&t);
                if v.get("method").and_then(|m| m.as_str()) == Some("chat.message.completed") {
                    // 简单校验 params.conversationId
                    let cid = v
                        .get("params")
                        .and_then(|p| p.get("conversationId"))
                        .and_then(|s| s.as_str());
                    if cid == Some("cid-other") {
                        got_other = true;
                        break;
                    }
                }
            }
            _ => break,
        }
    }
    assert!(!got_other, "non-matching chat.* should be filtered");
}
