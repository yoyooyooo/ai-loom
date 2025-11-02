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
async fn ws_file_save_ok_and_conflict() {
    let root = tempdir();
    std::fs::write(root.join("a.txt"), b"hello\n").unwrap();
    let (addr, _jh) = start_server(&root).await;
    // connect
    let url = format!("ws://{}/ws", addr);
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
    let (mut write, mut read) = ws_stream.split();
    let _ = read.next().await; // welcome

    // call file.getFull to get digest
    let req_ff = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"file.getFull","params":{"path":"a.txt"}});
    write.send(Message::Text(req_ff.to_string())).await.unwrap();
    let resp_ff_txt = loop {
        if let Some(Ok(Message::Text(t))) = read.next().await {
            if t.contains("\"id\":1") {
                break t;
            }
        } else {
            panic!("no response");
        }
    };
    let resp_ff: serde_json::Value = serde_json::from_str(&resp_ff_txt).unwrap();
    let digest = resp_ff
        .get("result")
        .and_then(|r| r.get("digest"))
        .and_then(|d| d.as_str())
        .unwrap()
        .to_string();

    // save ok
    let req_save = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"file.save","params":{"path":"a.txt","content":"hello world\n","baseDigest":digest}});
    write
        .send(Message::Text(req_save.to_string()))
        .await
        .unwrap();
    let resp_save_txt = loop {
        if let Some(Ok(Message::Text(t))) = read.next().await {
            if t.contains("\"id\":2") {
                break t;
            }
        } else {
            panic!("no response");
        }
    };
    let resp_save: serde_json::Value = serde_json::from_str(&resp_save_txt).unwrap();
    assert!(resp_save
        .get("result")
        .and_then(|r| r.get("ok"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false));

    // save conflict with wrong baseDigest
    let req_conf = serde_json::json!({"jsonrpc":"2.0","id":3,"method":"file.save","params":{"path":"a.txt","content":"other\n","baseDigest":"deadbeef"}});
    write
        .send(Message::Text(req_conf.to_string()))
        .await
        .unwrap();
    let resp_conf_txt = loop {
        if let Some(Ok(Message::Text(t))) = read.next().await {
            if t.contains("\"id\":3") {
                break t;
            }
        } else {
            panic!("no response");
        }
    };
    let resp_conf: serde_json::Value = serde_json::from_str(&resp_conf_txt).unwrap();
    let err_code = resp_conf
        .get("error")
        .and_then(|e| e.get("code"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    assert_eq!(err_code, "CONFLICT");
}
