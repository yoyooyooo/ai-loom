use std::{net::SocketAddr, path::PathBuf};

use ailoom_fs::FsConfig;
use ailoom_server::{router, state::AppState, ws};
use ailoom_store::Store;
use futures_util::StreamExt;
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

#[tokio::test]
async fn ws_welcome_handshake() {
    let root = tempdir();
    let (addr, _jh) = start_server(&root).await;
    let url = format!("ws://{}/ws", addr);
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
    let (mut _write, mut read) = ws_stream.split();
    let msg = read.next().await.unwrap().unwrap();
    let txt = match msg {
        Message::Text(s) => s,
        _ => panic!("unexpected first frame"),
    };
    let v: serde_json::Value = serde_json::from_str(&txt).unwrap();
    assert_eq!(
        v.get("method").and_then(|m| m.as_str()),
        Some("session.welcome")
    );
    let limits = v
        .get("params")
        .and_then(|p| p.get("limits"))
        .cloned()
        .unwrap();
    assert!(limits.get("maxMessageBytes").is_some());
    assert!(limits.get("requestTimeoutMs").is_some());
}
