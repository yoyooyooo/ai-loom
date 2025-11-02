use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use std::{process::Stdio, sync::Arc};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::{client::AppServerClient, transport::JsonRpcPeer};
use crate::SharedEventHub;

#[derive(Clone)]
pub struct CodexClient {
    child: Arc<tokio::sync::Mutex<Child>>, // keep handle for lifecycle
    app: Arc<AppServerClient>,
}

impl CodexClient {
    pub async fn start(cwd: Option<std::path::PathBuf>) -> Result<Arc<Self>> {
        let version = std::env::var("CODEX_VERSION").unwrap_or_else(|_| "0.53.0".into());
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
        // 避免僵尸：尽量让子进程随父进程退出
        cmd.kill_on_drop(true);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        // 普通 tokio spawn（更兼容，若需进程组可后续再开关）
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
        // initialize handshake；若失败或超时则终止子进程
        if let Err(err) = app.initialize().await {
            let _ = child.kill().await;
            return Err(anyhow!("initialize codex app-server failed: {err}"));
        }
        // Per-conv 模式下不做“全局恢复监听”，避免在新进程上对历史会话 addListener 造成 not found。
        // 默认 per_conv；如需单实例，请设置 AILOOM_CODEX_MODE=singleton
        let per_conv = std::env::var("AILOOM_CODEX_MODE")
            .ok()
            .map(|v| v == "per_conv")
            .unwrap_or(true);
        if !per_conv {
            app.restore_active_conversation_listeners().await;
        }

        let client = Arc::new(CodexClient {
            child: Arc::new(tokio::sync::Mutex::new(child)),
            app,
        });

        Ok(client)
    }

    pub fn register_event_hub(&self, hub: SharedEventHub) {
        self.app.register_event_hub(hub);
    }

    pub fn app(&self) -> Arc<AppServerClient> {
        self.app.clone()
    }

    pub async fn is_alive(&self) -> bool {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    pub async fn terminate(&self) {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
    }

    pub async fn pid(&self) -> Option<u32> {
        let child = self.child.lock().await;
        child.id()
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

/// 强制终止当前 codex app-server 进程并清空全局引用。
/// 下次调用 get_or_start() 会自动重启。
pub async fn force_kill_and_clear() {
    let mut guard = CODEX_CLIENT.lock().await;
    if let Some(client) = guard.take() {
        client.terminate().await;
    }
}

/// 获取当前已启动的 CodexClient（若无则返回 None）。不触发启动。
pub async fn current() -> Option<Arc<CodexClient>> {
    let guard = CODEX_CLIENT.lock().await;
    guard.clone()
}
