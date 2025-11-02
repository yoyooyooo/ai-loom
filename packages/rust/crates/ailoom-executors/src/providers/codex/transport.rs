use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
};

use anyhow::{anyhow, Result};
use codex_app_server_protocol::{
    JSONRPCError, JSONRPCMessage, JSONRPCNotification, JSONRPCRequest, JSONRPCResponse, RequestId,
};
use serde::de::DeserializeOwned;
use tokio::time::{timeout, Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::{oneshot, Mutex},
};

#[derive(Debug)]
pub enum PendingResponse {
    Result(JSONRPCResponse),
    Error(JSONRPCError),
    Shutdown,
}

#[async_trait::async_trait]
pub trait JsonRpcCallbacks: Send + Sync {
    async fn on_server_request(
        &self,
        peer: &JsonRpcPeer,
        raw: &str,
        request: JSONRPCRequest,
    ) -> Result<()>;

    async fn on_response(
        &self,
        _peer: &JsonRpcPeer,
        _raw: &str,
        _response: &JSONRPCResponse,
    ) -> Result<()> {
        Ok(())
    }

    async fn on_notification(
        &self,
        _peer: &JsonRpcPeer,
        _raw: &str,
        _notification: JSONRPCNotification,
    ) -> Result<bool> {
        Ok(false)
    }

    async fn on_error(&self, _peer: &JsonRpcPeer, _raw: &str, _error: &JSONRPCError) -> Result<()> {
        Ok(())
    }

    async fn on_non_json(&self, _raw: &str) -> Result<()> {
        Ok(())
    }

    async fn on_shutdown(&self, _peer: &JsonRpcPeer) -> Result<()> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct JsonRpcPeer {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<RequestId, oneshot::Sender<PendingResponse>>>>,
    labels: Arc<Mutex<HashMap<RequestId, String>>>,
    id_counter: Arc<AtomicI64>,
}

impl JsonRpcPeer {
    pub fn spawn(
        stdin: ChildStdin,
        stdout: ChildStdout,
        callbacks: Arc<dyn JsonRpcCallbacks>,
    ) -> Self {
        let peer = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            labels: Arc::new(Mutex::new(HashMap::new())),
            id_counter: Arc::new(AtomicI64::new(1)),
        };
        let reader_peer = peer.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = String::new();
            loop {
                buf.clear();
                match reader.read_line(&mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = buf.trim_end_matches(['\n', '\r']);
                        if line.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<JSONRPCMessage>(line) {
                            Ok(JSONRPCMessage::Request(request)) => {
                                let _ = callbacks
                                    .on_server_request(&reader_peer, line, request)
                                    .await;
                            }
                            Ok(JSONRPCMessage::Notification(notification)) => {
                                match callbacks
                                    .on_notification(&reader_peer, line, notification)
                                    .await
                                {
                                    Ok(true) => break,
                                    Ok(false) => {}
                                    Err(err) => {
                                        tracing::warn!(
                                            target:"codex.rpc",
                                            error=%err,
                                            "notification callback failed"
                                        );
                                        break;
                                    }
                                }
                            }
                            Ok(JSONRPCMessage::Response(response)) => {
                                let _ = callbacks.on_response(&reader_peer, line, &response).await;
                                reader_peer.resolve_response(response).await;
                            }
                            Ok(JSONRPCMessage::Error(error)) => {
                                let _ = callbacks.on_error(&reader_peer, line, &error).await;
                                reader_peer.resolve_error(error).await;
                            }
                            Err(_) => {
                                let _ = callbacks.on_non_json(line).await;
                            }
                        }
                    }
                    Err(err) => {
                        tracing::warn!(target:"codex.rpc", "stdin read error: {err}");
                        break;
                    }
                }
            }
            let _ = reader_peer.shutdown().await;
            if let Err(err) = callbacks.on_shutdown(&reader_peer).await {
                tracing::warn!(target:"codex.rpc", error=%err, "shutdown callback failed");
            }
        });
        peer
    }

    pub fn next_request_id(&self) -> RequestId {
        RequestId::Integer(self.id_counter.fetch_add(1, Ordering::Relaxed))
    }

    pub async fn register(&self, id: RequestId) -> oneshot::Receiver<PendingResponse> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        rx
    }

    pub fn label_for(&self, id: &RequestId) -> Option<String> {
        self.labels.try_lock().ok().and_then(|m| m.get(id).cloned())
    }

    async fn resolve_response(&self, response: JSONRPCResponse) {
        let id = response.id.clone();
        if let Some(tx) = self.pending.lock().await.remove(&id) {
            let _ = tx.send(PendingResponse::Result(response));
        }
        let _ = self.labels.lock().await.remove(&id);
    }

    async fn resolve_error(&self, error: JSONRPCError) {
        let id = error.id.clone();
        if let Some(tx) = self.pending.lock().await.remove(&id) {
            let _ = tx.send(PendingResponse::Error(error));
        }
        let _ = self.labels.lock().await.remove(&id);
    }

    pub async fn shutdown(&self) -> Result<()> {
        let mut pending = self.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(PendingResponse::Shutdown);
        }
        Ok(())
    }

    pub async fn send_message(&self, message: &JSONRPCMessage) -> Result<()> {
        let mut guard = self.stdin.lock().await;
        let raw = serde_json::to_vec(message)?;
        guard.write_all(&raw).await?;
        guard.write_all(b"\n").await?;
        guard.flush().await?;
        Ok(())
    }

    pub async fn request<R: DeserializeOwned>(
        &self,
        request: JSONRPCRequest,
        label: &str,
    ) -> Result<R> {
        let request_id = request.id.clone();
        let rx = self.register(request_id.clone()).await;
        self.labels
            .lock()
            .await
            .insert(request_id.clone(), label.to_string());
        self.send_message(&JSONRPCMessage::Request(request)).await?;
        // 统一超时（可配置）：避免上游永远等待导致 HTTP 挂起
        let timeout_ms: u64 = std::env::var("AILOOM_CODEX_RPC_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(30_000);
        let awaited = if timeout_ms > 0 {
            match timeout(Duration::from_millis(timeout_ms), rx).await {
                Ok(v) => v,
                Err(_) => return Err(anyhow!("{label} request timeout after {}ms", timeout_ms)),
            }
        } else {
            rx.await
        };
        match awaited {
            Ok(PendingResponse::Result(response)) => serde_json::from_value::<R>(response.result)
                .map_err(|err| anyhow!("failed to decode {label} response: {err}")),
            Ok(PendingResponse::Error(error)) => Err(anyhow!(
                "{label} request failed: {} ({})",
                error.error.message,
                error.error.code
            )),
            Ok(PendingResponse::Shutdown) => {
                Err(anyhow!("server shutdown while waiting for {label}"))
            }
            Err(_) => Err(anyhow!("{label} request dropped before response")),
        }
    }

    pub async fn send_notification(&self, notification: JSONRPCNotification) -> Result<()> {
        self.send_message(&JSONRPCMessage::Notification(notification))
            .await
    }

    pub async fn send_response(&self, response: JSONRPCResponse) -> Result<()> {
        self.send_message(&JSONRPCMessage::Response(response)).await
    }
}
