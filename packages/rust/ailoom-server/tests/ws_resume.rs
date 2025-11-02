use std::{net::SocketAddr, path::PathBuf};

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

#[tokio::test]
async fn ws_events_resume_after_write() {
    let root = tempdir();
    // seed one file and a write change
    std::fs::write(root.join("a.txt"), b"hello\n").unwrap();
    let (addr, _jh) = start_server(&root).await;

    // perform REST PUT to trigger file.changed
    let client = reqwest::Client::new();
    let put_body = serde_json::json!({"path":"a.txt","content":"hello world\n","baseDigest":null});
    let http_url = format!("http://{}/api/file", addr);
    let resp_put = client.put(http_url).json(&put_body).send().await.unwrap();
    assert!(resp_put.status().is_success());

    // connect ws
    let url = format!("ws://{}/ws", addr);
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
    let (mut write, mut read) = ws_stream.split();
    // consume welcome
    let _ = read.next().await;

    // call events.resume after=0
    let req =
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"events.resume","params":{"after":0}});
    write.send(Message::Text(req.to_string())).await.unwrap();
    let resp_txt = loop {
        if let Some(Ok(Message::Text(t))) = read.next().await {
            if t.contains("\"id\":1") {
                break t;
            }
        } else {
            panic!("no response");
        }
    };
    let resp: serde_json::Value = serde_json::from_str(&resp_txt).unwrap();
    let events = resp
        .get("result")
        .and_then(|r| r.get("events"))
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();
    assert!(events
        .iter()
        .any(|ev| ev.get("method").and_then(|m| m.as_str()) == Some("file.changed")));
}
