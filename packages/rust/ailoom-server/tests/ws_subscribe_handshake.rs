use std::{net::SocketAddr, path::PathBuf, time::Duration};

use ailoom_fs::FsConfig;
use ailoom_server::{router, state::AppState, ws};
use ailoom_store::Store;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

fn tempdir() -> PathBuf {
    let p = std::env::temp_dir().join(format!("ailoom_ws_test_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn start_server(root: &PathBuf) -> (SocketAddr, tokio::task::JoinHandle<()>) {
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
        ws_hub: Some(hub),
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
    (addr, join)
}

fn parse_json(txt: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(txt).unwrap_or_else(|_| serde_json::json!({}))
}

#[tokio::test]
async fn subscribe_chat_triggers_handshake_once_and_refcount_controls_replay() {
    let root = tempdir();
    let (addr, _jh) = start_server(&root).await;

    let url = format!("ws://{}/ws", addr);
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
    let (mut write, mut read) = ws_stream.split();

    // 1) welcome
    let _ = read.next().await; // session.welcome

    // 2) first subscribe with after=0, tail=3
    let sub_req1 = serde_json::json!({
        "jsonrpc":"2.0",
        "id": 1,
        "method":"subscribe",
        "params": {
            "topic":"chat",
            "filter": { "conversationId": "cid-handshake" },
            "after": 0,
            "tail": 3
        }
    });
    write
        .send(Message::Text(sub_req1.to_string()))
        .await
        .unwrap();

    // 2.1) consume subscribe response and collect handshake notifications
    let mut token: Option<String> = None;
    let mut got_begin = false;
    let mut got_end = false;
    let mut end_upto: u64 = 0;

    // We expect few frames quickly: 1 response + sync_begin + sync_end
    for _ in 0..5 {
        if let Some(Ok(Message::Text(t))) = read.next().await {
            let v = parse_json(&t);
            if v.get("id").and_then(|x| x.as_i64()) == Some(1) {
                token = v
                    .get("result")
                    .and_then(|r| r.get("token"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
            }
            if v.get("method").and_then(|m| m.as_str()) == Some("chat.session.sync_begin") {
                got_begin = true;
            }
            if v.get("method").and_then(|m| m.as_str()) == Some("chat.session.sync_end") {
                got_end = true;
                end_upto = v
                    .get("params")
                    .and_then(|p| p.get("uptoEventId"))
                    .and_then(|x| x.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| {
                        v.get("params")
                            .and_then(|p| p.get("uptoEventId"))
                            .and_then(|x| x.as_u64())
                    })
                    .unwrap_or(0);
            }
            if got_begin && got_end && token.is_some() {
                break;
            }
        }
    }

    assert!(token.is_some(), "subscribe should return a token");
    assert!(got_begin, "first subscribe should emit sync_begin");
    assert!(got_end, "first subscribe should emit sync_end");
    assert_eq!(
        end_upto, 0,
        "no chat events seeded → uptoEventId should be 0"
    );

    // 3) duplicate subscribe with same filter should NOT trigger another handshake
    let sub_req2 = serde_json::json!({
        "jsonrpc":"2.0",
        "id": 2,
        "method":"subscribe",
        "params": {
            "topic":"chat",
            "filter": { "conversationId": "cid-handshake" },
            "after": 0,
            "tail": 3
        }
    });
    write
        .send(Message::Text(sub_req2.to_string()))
        .await
        .unwrap();

    // 3.1) expect response id=2, and within a short window, no sync_begin/end
    let mut seen_resp2 = false;
    let mut dup_begin = false;
    let mut dup_end = false;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
    loop {
        let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
        if timeout.is_zero() {
            break;
        }
        let fut = read.next();
        match tokio::time::timeout(timeout, fut).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v = parse_json(&t);
                if v.get("id").and_then(|x| x.as_i64()) == Some(2) {
                    seen_resp2 = true;
                }
                if v.get("method").and_then(|m| m.as_str()) == Some("chat.session.sync_begin") {
                    dup_begin = true;
                    break;
                }
                if v.get("method").and_then(|m| m.as_str()) == Some("chat.session.sync_end") {
                    dup_end = true;
                    break;
                }
            }
            _ => break, // timeout or socket closed
        }
    }
    assert!(seen_resp2, "second subscribe should respond");
    assert!(
        !dup_begin && !dup_end,
        "duplicate subscribe must not trigger handshake"
    );

    // 4) unsubscribe twice → ref_count drops to 0, then subscribe should trigger handshake again
    let tok = token.unwrap();
    let unsub1 =
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"unsubscribe","params":{"token": tok}});
    write.send(Message::Text(unsub1.to_string())).await.unwrap();
    // read resp id=3
    loop {
        if let Some(Ok(Message::Text(t))) = read.next().await {
            let v = parse_json(&t);
            if v.get("id").and_then(|x| x.as_i64()) == Some(3) {
                break;
            }
        } else {
            break;
        }
    }
    let unsub2 =
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"unsubscribe","params":{"token": tok}});
    write.send(Message::Text(unsub2.to_string())).await.unwrap();
    // read resp id=4
    loop {
        if let Some(Ok(Message::Text(t))) = read.next().await {
            let v = parse_json(&t);
            if v.get("id").and_then(|x| x.as_i64()) == Some(4) {
                break;
            }
        } else {
            break;
        }
    }

    // 等待退订宽限清理（若启用 AILOOM_WS_UNSUB_GRACE_MS，默认 300ms）
    tokio::time::sleep(Duration::from_millis(450)).await;

    // subscribe again (id=5) → should trigger handshake (begin/end)
    let sub_req3 = serde_json::json!({
        "jsonrpc":"2.0",
        "id": 5,
        "method":"subscribe",
        "params": {
            "topic":"chat",
            "filter": { "conversationId": "cid-handshake" },
            "after": 0,
            "tail": 3
        }
    });
    write
        .send(Message::Text(sub_req3.to_string()))
        .await
        .unwrap();

    let mut got_begin3 = false;
    let mut got_end3 = false;
    let mut seen_resp5 = false;
    for _ in 0..6 {
        if let Some(Ok(Message::Text(t))) = read.next().await {
            let v = parse_json(&t);
            if v.get("id").and_then(|x| x.as_i64()) == Some(5) {
                seen_resp5 = true;
            }
            if v.get("method").and_then(|m| m.as_str()) == Some("chat.session.sync_begin") {
                got_begin3 = true;
            }
            if v.get("method").and_then(|m| m.as_str()) == Some("chat.session.sync_end") {
                got_end3 = true;
            }
            if seen_resp5 && got_begin3 && got_end3 {
                break;
            }
        }
    }
    assert!(seen_resp5, "third subscribe should respond");
    assert!(
        got_begin3 && got_end3,
        "subscribe after ref=0(+grace) should handshake"
    );
}
