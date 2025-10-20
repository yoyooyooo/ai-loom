use std::{net::SocketAddr, path::PathBuf};

use ailoom_server::{router, state::AppState, ws};
use ailoom_fs::FsConfig;
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
  let store = Store::connect_path(&db, &ws_root.to_string_lossy()).await.unwrap();
  let hub = ws::hub::Hub::new(1024);
  let app_state = AppState { fs: fs_cfg, store, root: ws_root.clone(), workspace_root: ws_root, ws_hub: Some(hub) };
  let app = router::build_router(app_state, PathBuf::from("packages/web/dist"), true);
  let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127,0,0,1],0))).await.unwrap();
  let addr = listener.local_addr().unwrap();
  let join = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
  (addr, join)
}

#[tokio::test]
async fn rpc_tree_get_and_broadcast_on_file_put() {
  let root = tempdir();
  // seed one file and folder
  std::fs::create_dir_all(root.join("src")).unwrap();
  std::fs::write(root.join("src").join("a.txt"), b"hello\nworld\n").unwrap();
  let (addr, _jh) = start_server(&root).await;
  // quick sanity: REST tree
  let http_client = reqwest::Client::new();
  let rest_tree_url = format!("http://{}/api/tree?dir=src", addr);
  let r = http_client.get(&rest_tree_url).send().await.unwrap();
  let status = r.status();
  let body = r.text().await.unwrap();
  assert!(status.is_success(), "REST tree should work, got {} body={} ", status, body);
  assert!(body.contains("a.txt"), "REST tree missing file: {body}");
  // connect ws
  let url = format!("ws://{}/ws", addr);
  let (ws_stream, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
  let (mut write, mut read) = ws_stream.split();
  // first frame welcome
  let _ = read.next().await;

  // call tree.get
  let req = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tree.get","params":{"dir":"src"}});
  write.send(Message::Text(req.to_string())).await.unwrap();
  let resp_txt = loop { if let Some(Ok(Message::Text(t))) = read.next().await { if t.contains("\"id\":1") { break t; } } else { panic!("no response"); } };
  let resp: serde_json::Value = serde_json::from_str(&resp_txt).unwrap();
  assert!(resp.get("result").is_some(), "tree.get should return result: {resp_txt}");

  // subscribe file topic for a specific path
  let sub_req = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"subscribe","params":{"topic":"file","filter":{"path":"src/a.txt"}}});
  write.send(Message::Text(sub_req.to_string())).await.unwrap();
  // consume subscribe response
  let _ = read.next().await;

  // call REST PUT /api/file to trigger broadcast
  let client = reqwest::Client::new();
  let put_body = serde_json::json!({"path":"src/a.txt","content":"hello\nworld!!!\n","baseDigest":null});
  let http_url = format!("http://{}/api/file", addr);
  let resp_put = client.put(http_url).json(&put_body).send().await.unwrap();
  assert!(resp_put.status().is_success());

  // expect file.changed notification
  let mut got_changed = false;
  for _ in 0..20 { // up to ~2s
    if let Some(Ok(Message::Text(t))) = read.next().await {
      if t.contains("\"method\":\"file.changed\"") && t.contains("src/a.txt") { got_changed = true; break; }
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
  }
  assert!(got_changed, "should receive file.changed for src/a.txt");
}
