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
async fn subscribe_many_triggers_handshake_per_new_token_and_respects_refcount() {
    let root = tempdir();
    let (addr, _jh) = start_server(&root).await;

    let url = format!("ws://{}/ws", addr);
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
    let (mut write, mut read) = ws_stream.split();

    // consume welcome
    let _ = read.next().await;

    // 1) subscribeMany with two chat items
    let req1 = serde_json::json!({
        "jsonrpc":"2.0",
        "id": 1,
        "method":"subscribeMany",
        "params": {
            "items": [
                {"topic":"chat","filter":{"conversationId":"cid-m-1"},"after":0,"tail":1},
                {"topic":"chat","filter":{"conversationId":"cid-m-2"},"after":0,"tail":1}
            ]
        }
    });
    write.send(Message::Text(req1.to_string())).await.unwrap();

    // expect response + two begin + two end (order not strictly guaranteed)
    let mut seen_resp = false;
    let mut begin_count = 0u32;
    let mut end_count = 0u32;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
    loop {
        let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
        if timeout.is_zero() {
            break;
        }
        match tokio::time::timeout(timeout, read.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v = parse_json(&t);
                if v.get("id").and_then(|x| x.as_i64()) == Some(1) {
                    seen_resp = true;
                    let tokens_opt = v
                        .get("result")
                        .and_then(|r| r.get("tokens"))
                        .and_then(|x| x.as_array());
                    assert!(tokens_opt.is_some());
                    let toks = tokens_opt.unwrap();
                    assert_eq!(toks.len(), 2);
                }
                if v.get("method").and_then(|m| m.as_str()) == Some("chat.session.sync_begin") {
                    begin_count += 1;
                }
                if v.get("method").and_then(|m| m.as_str()) == Some("chat.session.sync_end") {
                    end_count += 1;
                }
                if seen_resp && begin_count >= 2 && end_count >= 2 {
                    break;
                }
            }
            _ => break,
        }
    }
    assert!(seen_resp, "subscribeMany should respond with tokens");
    assert_eq!(begin_count, 2);
    assert_eq!(end_count, 2);

    // 2) repeat subscribeMany with the same items: should not emit begin/end again
    let req2 = serde_json::json!({
        "jsonrpc":"2.0",
        "id": 2,
        "method":"subscribeMany",
        "params": {
            "items": [
                {"topic":"chat","filter":{"conversationId":"cid-m-1"}},
                {"topic":"chat","filter":{"conversationId":"cid-m-2"}}
            ]
        }
    });
    write.send(Message::Text(req2.to_string())).await.unwrap();
    let mut seen_resp2 = false;
    let mut dup_hs = false;
    let deadline2 = tokio::time::Instant::now() + Duration::from_millis(300);
    loop {
        let timeout = deadline2.saturating_duration_since(tokio::time::Instant::now());
        if timeout.is_zero() {
            break;
        }
        match tokio::time::timeout(timeout, read.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v = parse_json(&t);
                if v.get("id").and_then(|x| x.as_i64()) == Some(2) {
                    seen_resp2 = true;
                }
                if let Some(m) = v.get("method").and_then(|m| m.as_str()) {
                    if m == "chat.session.sync_begin" || m == "chat.session.sync_end" {
                        dup_hs = true;
                        break;
                    }
                }
            }
            _ => break,
        }
    }
    assert!(seen_resp2, "second subscribeMany should respond");
    assert!(
        !dup_hs,
        "duplicate subscribeMany must not trigger handshake again"
    );
}
