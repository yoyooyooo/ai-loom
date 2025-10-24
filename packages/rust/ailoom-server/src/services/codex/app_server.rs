use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use std::{process::Stdio, sync::Arc};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::{client::AppServerClient, transport::JsonRpcPeer};
use crate::ws::hub::Hub;

#[derive(Clone)]
pub struct CodexClient {
    child: Arc<tokio::sync::Mutex<Child>>, // keep handle for lifecycle
    app: Arc<AppServerClient>,
}

impl CodexClient {
    pub async fn start(cwd: Option<std::path::PathBuf>) -> Result<Arc<Self>> {
        let version = std::env::var("CODEX_VERSION").unwrap_or_else(|_| "0.50.0".into());
        let package_spec = format!("@openai/codex@{version}");
        let mut cmd = Command::new("npx");
        // 固定版本并设置若干环境变量降噪
        cmd.args(["-y", &package_spec, "app-server"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        cmd.env("NODE_NO_WARNINGS", "1");
        cmd.env("NO_COLOR", "1");
        cmd.env("RUST_LOG", "error");
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow!("spawn codex app-server failed: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("child stdin missing"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("child stdout missing"))?;

        let app = AppServerClient::new();
        let peer = JsonRpcPeer::spawn(stdin, stdout, app.clone());
        app.connect(peer);
        // initialize handshake；若失败则终止子进程
        if let Err(err) = app.initialize().await {
            let _ = child.kill().await;
            return Err(anyhow!("initialize codex app-server failed: {err}"));
        }

        let client = Arc::new(CodexClient {
            child: Arc::new(tokio::sync::Mutex::new(child)),
            app,
        });

        Ok(client)
    }

    pub fn register_ws_hub(&self, hub: Hub) {
        self.app.register_ws_hub(hub);
    }

    pub fn app(&self) -> Arc<AppServerClient> {
        self.app.clone()
    }

    async fn is_alive(&self) -> bool {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    async fn terminate(&self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }
}

static CODEX_CLIENT: Lazy<Mutex<Option<Arc<CodexClient>>>> = Lazy::new(|| Mutex::new(None));

pub async fn get_or_start(global_cwd: Option<std::path::PathBuf>) -> Result<Arc<CodexClient>> {
    let mut guard = CODEX_CLIENT.lock().await;

    if let Some(existing) = guard.as_ref() {
        if existing.is_alive().await {
            return Ok(existing.clone());
        } else {
            tracing::warn!(target: "codex", "codex app-server exited unexpectedly，restarting");
            existing.terminate().await;
            *guard = None;
        }
    }

    let client = CodexClient::start(global_cwd).await?;
    *guard = Some(client.clone());
    Ok(client)
}
