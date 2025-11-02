use std::{net::SocketAddr, path::PathBuf, time::Duration};

use ailoom_fs::FsConfig;
use ailoom_server::{router, state::AppState, ws};
use ailoom_store::Store;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

fn tempdir() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "ailoom_ws_test_unsub_grace_{}",
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
async fn unsubscribe_grace_prevents_handshake_and_keeps_gating_match() {
    // 设置 400ms 宽限
    std::env::set_var("AILOOM_WS_UNSUB_GRACE_MS", "400");

    let root = tempdir();
    let (addr, _jh, hub) = start_server(&root).await;
    let cid = "cid-grace";

    let url = format!("ws://{}/ws", addr);
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
    let (mut write, mut read) = ws_stream.split();
    let _ = read.next().await; // welcome

    // 1) subscribe
    let sub = json!({
        "jsonrpc":"2.0","id":1,"method":"subscribe",
        "params": {"topic":"chat","filter":{"conversationId": cid}, "after":0, "tail": 1}
    });
    write.send(Message::Text(sub.to_string())).await.unwrap();
    // 读到响应与握手 begin/end
    let mut seen_begin = false;
    let mut seen_end = false;
    let mut seen_resp = false;
    for _ in 0..5 {
        if let Some(Ok(Message::Text(t))) = read.next().await {
            let v = parse_json(&t);
            if v.get("id").and_then(|x| x.as_i64()) == Some(1) {
                seen_resp = true;
            }
            match v.get("method").and_then(|m| m.as_str()).unwrap_or("") {
                "chat.session.sync_begin" => seen_begin = true,
                "chat.session.sync_end" => seen_end = true,
                _ => {}
            }
            if seen_resp && seen_begin && seen_end {
                break;
            }
        }
    }
    assert!(seen_resp && seen_begin && seen_end);

    // 2) 立即 unsubscribe（进入 400ms 宽限）
    let token = format!("chat:{{\"conversationId\":\"{}\"}}", cid);
    let unsub = json!({"jsonrpc":"2.0","id":2,"method":"unsubscribe","params":{"token": token }});
    write.send(Message::Text(unsub.to_string())).await.unwrap();
    let _ = read.next().await; // resp id=2

    // 2.1) 宽限期内广播 → 仍应转发（gating 命中）
    hub.broadcast(
        "chat.message.completed".into(),
        json!({"conversationId": cid, "text": "grace"}),
    );
    let mut got_grace_msg = false;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(200);
    loop {
        let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
        if timeout.is_zero() {
            break;
        }
        match tokio::time::timeout(timeout, read.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v = parse_json(&t);
                if v.get("method").and_then(|m| m.as_str()) == Some("chat.message.completed") {
                    got_grace_msg = true;
                    break;
                }
            }
            _ => break,
        }
    }
    assert!(got_grace_msg, "events during grace should be forwarded");

    // 3) 宽限期内重新 subscribe → 不应再次握手
    let sub2 = json!({
        "jsonrpc":"2.0","id":3,"method":"subscribe",
        "params": {"topic":"chat","filter":{"conversationId": cid}, "after":0, "tail": 1}
    });
    write.send(Message::Text(sub2.to_string())).await.unwrap();
    let mut seen_resp3 = false;
    let mut dup_begin = false;
    let mut dup_end = false;
    let deadline2 = tokio::time::Instant::now() + Duration::from_millis(300);
    loop {
        let timeout = deadline2.saturating_duration_since(tokio::time::Instant::now());
        if timeout.is_zero() {
            break;
        }
        match tokio::time::timeout(timeout, read.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v = parse_json(&t);
                if v.get("id").and_then(|x| x.as_i64()) == Some(3) {
                    seen_resp3 = true;
                }
                match v.get("method").and_then(|m| m.as_str()).unwrap_or("") {
                    "chat.session.sync_begin" => {
                        dup_begin = true;
                        break;
                    }
                    "chat.session.sync_end" => {
                        dup_end = true;
                        break;
                    }
                    _ => {}
                }
            }
            _ => break,
        }
    }
    assert!(seen_resp3, "subscribe should respond");
    assert!(
        !dup_begin && !dup_end,
        "resubscribe within grace must not handshake"
    );

    // 4) 宽限过后，退订并等待清理，再广播 → 不应收到
    let unsub3 = json!({"jsonrpc":"2.0","id":4,"method":"unsubscribe","params":{"token": token }});
    write.send(Message::Text(unsub3.to_string())).await.unwrap();
    let _ = read.next().await; // resp id=4
    tokio::time::sleep(Duration::from_millis(450)).await; // > grace
    hub.broadcast(
        "chat.message.completed".into(),
        json!({"conversationId": cid, "text":"gone"}),
    );
    let mut got_after_cleanup = false;
    let deadline3 = tokio::time::Instant::now() + Duration::from_millis(300);
    loop {
        let timeout = deadline3.saturating_duration_since(tokio::time::Instant::now());
        if timeout.is_zero() {
            break;
        }
        match tokio::time::timeout(timeout, read.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v = parse_json(&t);
                if v.get("method").and_then(|m| m.as_str()) == Some("chat.message.completed") {
                    got_after_cleanup = true;
                    break;
                }
            }
            _ => break,
        }
    }
    assert!(
        !got_after_cleanup,
        "after grace cleanup, events should be gated"
    );
}
