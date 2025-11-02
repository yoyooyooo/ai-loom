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

async fn start_server_with_watch(root: &PathBuf) -> (SocketAddr, tokio::task::JoinHandle<()>) {
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
    let _watch = ws::watch::spawn_watcher(app_state.clone());
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

// NOTE: FS 监听在 CI/容器/沙箱环境下存在平台差异，默认忽略；
// 手动运行：AILOOM_FSWATCH_ENABLED=1 cargo test -p ailoom-server --test ws_fs_watch -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn fs_watch_emits_tree_changed() {
    // 启用 FS Watcher
    std::env::set_var("AILOOM_FSWATCH_ENABLED", "1");
    std::env::set_var("AILOOM_FSWATCH_BATCH_MS", "200");
    std::env::set_var("AILOOM_FSWATCH_MAX_WINDOW_MS", "800");
    let root = tempdir();
    let (addr, _jh) = start_server_with_watch(&root).await;
    // 等待 watcher 初始化
    tokio::time::sleep(Duration::from_millis(200)).await;

    // connect ws
    let url = format!("ws://{}/ws", addr);
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
    let (mut write, mut read) = ws_stream.split();
    // consume welcome
    let _ = read.next().await;

    // subscribe to tree
    let sub_req = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"subscribe","params":{"topic":"tree","filter":{}}});
    write
        .send(Message::Text(sub_req.to_string()))
        .await
        .unwrap();
    let _ = read.next().await;

    // write a file to trigger fs event
    std::fs::write(root.join("foo.txt"), b"hello").unwrap();

    // expect tree.changed notification
    let res = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match read.next().await {
                Some(Ok(Message::Text(t))) => {
                    if t.contains("\"method\":\"tree.changed\"") {
                        break true;
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(_)) => {}
                None => break false,
            }
        }
    })
    .await;
    assert!(
        matches!(res, Ok(true)),
        "should receive tree.changed within timeout"
    );
}
