use std::{net::SocketAddr, path::PathBuf, time::Duration};

use ailoom_fs::FsConfig;
use ailoom_server::{router, state::AppState, ws};
use ailoom_store::Store;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

fn tempdir() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "ailoom_ws_test_handshake_interleave_{}",
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
    let hub = ws::hub::Hub::new(2048);
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
    let join = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, join, hub)
}

fn parse_json(txt: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(&txt).unwrap_or_else(|_| serde_json::json!({}))
}

#[tokio::test]
async fn handshake_replay_and_live_delta_interleave() {
    let root = tempdir();
    let (addr, _jh, hub) = start_server(&root).await;
    let cid = "cid-interleave";

    // 预先写入两条稳定事件，用于回放
    hub.broadcast("chat.session.new".into(), json!({"conversationId": cid}));
    hub.broadcast(
        "chat.message.completed".into(),
        json!({"conversationId": cid, "text": "hello"}),
    );

    // 连接 WS
    let url = format!("ws://{}/ws", addr);
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
    let (mut write, mut read) = ws_stream.split();
    let _ = read.next().await; // welcome

    // 订阅（触发握手回放）
    let sub = json!({
        "jsonrpc":"2.0","id":1,"method":"subscribe",
        "params": {"topic":"chat","filter":{"conversationId": cid}, "after":0, "tail": 16}
    });
    write.send(Message::Text(sub.to_string())).await.unwrap();

    // 在握手窗口内，插入一条 live delta
    tokio::spawn({
        let hub = hub.clone();
        let cid = cid.to_string();
        async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            hub.broadcast(
                "chat.message.delta".into(),
                json!({"conversationId": cid, "delta": "stream"}),
            );
        }
    });

    let mut seen_begin = false;
    let mut seen_completed = false; // from replay
    let mut seen_delta = false; // live
    let mut seen_end = false;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(800);
    loop {
        let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
        if timeout.is_zero() {
            break;
        }
        match tokio::time::timeout(timeout, read.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v = parse_json(&t);
                if v.get("id").and_then(|x| x.as_i64()) == Some(1) {
                    continue; // subscribe response
                }
                match v.get("method").and_then(|m| m.as_str()).unwrap_or("") {
                    "chat.session.sync_begin" => seen_begin = true,
                    "chat.session.sync_end" => seen_end = true,
                    "chat.message.completed" => {
                        let cidv = v
                            .get("params")
                            .and_then(|p| p.get("conversationId"))
                            .and_then(|x| x.as_str());
                        if cidv == Some(cid) {
                            seen_completed = true;
                        }
                    }
                    "chat.message.delta" => {
                        let cidv = v
                            .get("params")
                            .and_then(|p| p.get("conversationId"))
                            .and_then(|x| x.as_str());
                        if cidv == Some(cid) {
                            seen_delta = true;
                        }
                    }
                    _ => {}
                }
                if seen_begin && seen_completed && seen_delta && seen_end {
                    break;
                }
            }
            _ => break,
        }
    }
    assert!(seen_begin && seen_end, "握手 begin/end 应出现");
    assert!(seen_completed, "回放应包含稳定 completed 事件");
    assert!(seen_delta, "握手窗口内的 live delta 应直通");
}
