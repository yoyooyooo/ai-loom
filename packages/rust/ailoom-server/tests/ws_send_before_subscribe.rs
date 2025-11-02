use std::{net::SocketAddr, path::PathBuf, time::Duration};

use ailoom_fs::FsConfig;
use ailoom_server::{router, state::AppState, ws};
use ailoom_store::Store;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

fn tempdir() -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "ailoom_ws_test_send_before_sub_{}",
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
    serde_json::from_str::<serde_json::Value>(&txt).unwrap_or_else(|_| serde_json::json!({}))
}

#[tokio::test]
async fn persistent_events_broadcast_before_subscribe_are_replayed_in_handshake() {
    let root = tempdir();
    let (addr, _jh, hub) = start_server(&root).await;

    let cid = "cid-pre";
    // 1) 预先向 ring 写入持久化 chat.*（模拟“发送早于订阅”）
    hub.broadcast("chat.session.new".into(), json!({"conversationId": cid}));
    hub.broadcast(
        "chat.info.user_message".into(),
        json!({"conversationId": cid, "text": "hi"}),
    );

    // 2) 建立 WS 连接
    let url = format!("ws://{}/ws", addr);
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
    let (mut write, mut read) = ws_stream.split();
    // welcome
    let _ = read.next().await;

    // 3) 订阅 chat(cID=cid-pre) 且 after=0 → 触发握手并回放上述事件
    let sub = json!({
        "jsonrpc":"2.0","id":1,"method":"subscribe",
        "params": {"topic":"chat","filter":{"conversationId": cid}, "after":0, "tail": 16}
    });
    write.send(Message::Text(sub.to_string())).await.unwrap();

    let mut seen_resp = false;
    let mut seen_begin = false;
    let mut seen_session_new = false;
    let mut seen_user_msg = false;
    let mut seen_end = false;

    // 在一个短窗口内收集握手 begin → 回放 → end
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
                    seen_resp = true;
                }
                match v.get("method").and_then(|m| m.as_str()).unwrap_or("") {
                    "chat.session.sync_begin" => seen_begin = true,
                    "chat.session.sync_end" => seen_end = true,
                    "chat.session.new" => seen_session_new = true,
                    "chat.info.user_message" => seen_user_msg = true,
                    _ => {}
                }
                if seen_resp && seen_begin && seen_session_new && seen_user_msg && seen_end {
                    break;
                }
            }
            _ => break,
        }
    }

    assert!(seen_resp, "subscribe should respond");
    assert!(seen_begin && seen_end, "handshake begin/end must appear");
    assert!(
        seen_session_new && seen_user_msg,
        "persistent chat.* should be replayed"
    );
}
