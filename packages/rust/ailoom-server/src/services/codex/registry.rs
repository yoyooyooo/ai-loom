use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use tokio::sync::Mutex;

use codex_app_server_protocol::{NewConversationParams, ResumeConversationParams};

use super::app_server::{self, CodexClient};
use crate::routes::chat::resume::io::lookup_path_by_conversation_id;
use crate::ws::hub::Hub;

#[derive(Clone)]
struct ChildHandle {
    client: Arc<CodexClient>,
    conversation_id: String,
    cwd: PathBuf,
    created_ms: u64,
    last_used_ms: u64,
}

pub struct CodexRegistry {
    by_cid: HashMap<String, ChildHandle>,
}

static REGISTRY: Lazy<Mutex<CodexRegistry>> = Lazy::new(|| {
    Mutex::new(CodexRegistry {
        by_cid: HashMap::new(),
    })
});

fn to_string_path(path: &PathBuf) -> String {
    path.to_string_lossy().to_string()
}

impl CodexRegistry {
    fn insert(&mut self, handle: ChildHandle) {
        self.by_cid.insert(handle.conversation_id.clone(), handle);
    }

    fn get(&self, cid: &str) -> Option<ChildHandle> {
        self.by_cid.get(cid).cloned()
    }

    fn remove(&mut self, cid: &str) -> Option<ChildHandle> {
        self.by_cid.remove(cid)
    }
}

fn is_per_conv_mode() -> bool {
    // 默认 per_conv；显式设置 AILOOM_CODEX_MODE=singleton 可切回单实例
    std::env::var("AILOOM_CODEX_MODE")
        .ok()
        .map(|v| v == "per_conv")
        .unwrap_or(true)
}

/// 为新的会话拉起一个 Codex 子进程并 newConversation → addConversationListener。
pub async fn spawn_new(
    workspace_root: PathBuf,
    hub: Option<Hub>,
    mut params: NewConversationParams,
) -> Result<String> {
    // Singleton 模式：直接复用全局 app-server
    if !is_per_conv_mode() {
        if params.cwd.is_none() {
            params.cwd = Some(to_string_path(&workspace_root));
        }
        let client = app_server::get_or_start(Some(workspace_root.clone())).await?;
        if let Some(h) = hub.clone() {
            client.register_ws_hub(h);
        }
        let app = client.app();
        let resp = app.new_conversation(params).await?;
        let conversation_id = resp.conversation_id.to_string();
        app.ensure_listener(&conversation_id).await.ok();
        return Ok(conversation_id);
    }

    // per-conv：为该会话拉起子进程
    if params.cwd.is_none() {
        params.cwd = Some(to_string_path(&workspace_root));
    }
    let client = CodexClient::start(Some(workspace_root.clone())).await?;
    if let Some(h) = hub.clone() {
        client.register_ws_hub(h);
    }
    let app = client.app();
    let resp = app.new_conversation(params).await?;
    let conversation_id = resp.conversation_id.to_string();
    app.ensure_listener_resilient(&conversation_id).await?;
    let now = now_millis();
    let handle = ChildHandle {
        client: client.clone(),
        conversation_id: conversation_id.clone(),
        cwd: workspace_root.clone(),
        created_ms: now,
        last_used_ms: now,
    };
    {
        let mut guard = REGISTRY.lock().await;
        guard.insert(handle);
    }
    gc_if_needed().await;
    Ok(conversation_id)
}

/// 确保可以向指定会话发送消息：
/// - 若已存在子进程，直接使用；
/// - 若不存在，则拉起子进程并尝试通过 rollout 路径 resume 后建立监听。
pub async fn send_user_message(
    workspace_root: PathBuf,
    hub: Option<Hub>,
    conversation_id: &str,
    text: String,
) -> Result<()> {
    tracing::info!(target:"codex", conversationId=%conversation_id, "registry.send_user_message enter");
    if !is_per_conv_mode() {
        let client = app_server::get_or_start(Some(workspace_root.clone())).await?;
        if let Some(h) = hub.clone() {
            client.register_ws_hub(h);
        }
        let app = client.app();
        app.ensure_listener(conversation_id).await.ok();
        let _ = app
            .send_user_message(conversation_id.to_string(), text)
            .await?;
        return Ok(());
    }
    // 快路径：已有
    let maybe_handle = {
        let guard = REGISTRY.lock().await;
        guard.get(conversation_id)
    };
    if let Some(mut handle) = maybe_handle {
        // 若子进程已退出，丢弃旧句柄并走慢路径重建
        let alive = handle.client.is_alive().await;
        if alive {
            let app = handle.client.app();
            app.ensure_listener_resilient(conversation_id).await?;
            tracing::info!(target:"codex", conversationId=%conversation_id, "registry.send_user_message fast-path begin");
            let _ = app
                .send_user_message(conversation_id.to_string(), text.clone())
                .await?;
            tracing::info!(target:"codex", conversationId=%conversation_id, "registry.send_user_message fast-path ok");
            mark_used(&mut handle).await;
            {
                let mut guard = REGISTRY.lock().await;
                guard.insert(handle);
            }
            // 发送后不再叠加监听，依赖 resilient ensure 与流式回执；极端场景可考虑在 WS 连接层做一次轻量 resume。
            return Ok(());
        } else {
            tracing::warn!(target:"codex", conversationId=%conversation_id, "child not alive, restarting for send");
            let _ = REGISTRY.lock().await.remove(conversation_id);
            // 继续走慢路径
        }
    }

    // 慢路径：新拉起并 resume
    tracing::info!(target:"codex", conversationId=%conversation_id, "registry.send_user_message slow-path begin");
    let client = CodexClient::start(Some(workspace_root.clone())).await?;
    if let Some(h) = hub.clone() {
        client.register_ws_hub(h);
    }
    let app = client.app();

    // 尝试定位 rollout 路径
    let path = lookup_path_by_conversation_id(&app, conversation_id)
        .await
        .ok_or_else(|| anyhow!("未找到会话对应的 rollout 路径: {}", conversation_id))?;
    let params = ResumeConversationParams {
        path: Some(PathBuf::from(path.clone())),
        conversation_id: None,
        history: None,
        overrides: Some(NewConversationParams {
            cwd: Some(to_string_path(&workspace_root)),
            ..Default::default()
        }),
    };
    let resp = app.resume_conversation(params).await?;
    let cid = resp.conversation_id.to_string();
    // 建立监听并缓存
    let _ = app.ensure_listener_resilient(&cid).await;
    // 可选等待 sessionConfigured
    let now = now_millis();
    {
        let mut guard = REGISTRY.lock().await;
        guard.insert(ChildHandle {
            client,
            conversation_id: cid.clone(),
            cwd: workspace_root.clone(),
            created_ms: now,
            last_used_ms: now,
        });
    }
    // 发送
    let _ = app.send_user_message(cid.clone(), text).await?;
    tracing::info!(target:"codex", conversationId=%cid, "registry.send_user_message slow-path ok");
    // 发送后不再叠加监听，保持极简路径。
    Ok(())
}

/// 仅确保监听（不存在则尝试 resume 并建立监听）。
pub async fn ensure_listener(
    workspace_root: PathBuf,
    hub: Option<Hub>,
    conversation_id: &str,
) -> Result<()> {
    if !is_per_conv_mode() {
        let client = app_server::get_or_start(Some(workspace_root.clone())).await?;
        if let Some(h) = hub.clone() {
            client.register_ws_hub(h);
        }
        let app = client.app();
        app.ensure_listener_resilient(conversation_id).await?;
        return Ok(());
    }
    let maybe_handle = {
        let guard = REGISTRY.lock().await;
        guard.get(conversation_id)
    };
    if let Some(mut handle) = maybe_handle {
        let alive = handle.client.is_alive().await;
        if alive {
            let app = handle.client.app();
            app.ensure_listener_resilient(conversation_id).await?;
            mark_used(&mut handle).await;
            {
                let mut guard = REGISTRY.lock().await;
                guard.insert(handle);
            }
            return Ok(());
        } else {
            tracing::warn!(target:"codex", conversationId=%conversation_id, "child not alive, restarting for ensure");
            {
                let mut guard = REGISTRY.lock().await;
                let _ = guard.remove(conversation_id);
            }
            // 继续走慢路径
        }
    }
    // 无 handle：尝试拉起并 resume
    let client = CodexClient::start(Some(workspace_root.clone())).await?;
    if let Some(h) = hub.clone() {
        client.register_ws_hub(h);
    }
    let app = client.app();
    let path = lookup_path_by_conversation_id(&app, conversation_id)
        .await
        .ok_or_else(|| anyhow!("未找到会话对应的 rollout 路径: {}", conversation_id))?;
    let params = ResumeConversationParams {
        path: Some(PathBuf::from(path.clone())),
        conversation_id: None,
        history: None,
        overrides: Some(NewConversationParams {
            cwd: Some(to_string_path(&workspace_root)),
            ..Default::default()
        }),
    };
    let resp = app.resume_conversation(params).await?;
    let cid = resp.conversation_id.to_string();
    app.ensure_listener_resilient(&cid).await.ok();
    let now = now_millis();
    {
        let mut guard = REGISTRY.lock().await;
        guard.insert(ChildHandle {
            client,
            conversation_id: cid,
            cwd: workspace_root,
            created_ms: now,
            last_used_ms: now,
        });
    }
    Ok(())
}

// ——— GC 与观测 ———
fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn mark_used(handle: &mut ChildHandle) {
    handle.last_used_ms = now_millis();
}

async fn gc_if_needed() {
    let max_children: usize = std::env::var("AILOOM_CODEX_MAX_CHILDREN")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(6);
    let idle_ms_thresh: u64 = std::env::var("AILOOM_CODEX_CHILD_IDLE_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(60_000);
    let now = now_millis();

    // 当前总数
    let len = { REGISTRY.lock().await.by_cid.len() };
    if len <= max_children {
        // 清理超时 idle 的子进程：收集 → 释放锁 → 终止 → 再删表
        let to_kill: Vec<(String, Arc<CodexClient>)> = {
            let guard = REGISTRY.lock().await;
            guard
                .by_cid
                .iter()
                .filter_map(|(cid, h)| {
                    if now.saturating_sub(h.last_used_ms) > idle_ms_thresh {
                        Some((cid.clone(), h.client.clone()))
                    } else {
                        None
                    }
                })
                .collect()
        };
        for (_cid, client) in to_kill.iter() {
            let _ = client.terminate().await;
        }
        if !to_kill.is_empty() {
            let mut guard = REGISTRY.lock().await;
            for (cid, _client) in to_kill.into_iter() {
                guard.by_cid.remove(&cid);
            }
        }
        return;
    }

    // 超限：按最久未使用优先回收（仅回收超过 idle 阈值的）
    let items: Vec<(String, u64)> = {
        let guard = REGISTRY.lock().await;
        guard
            .by_cid
            .iter()
            .map(|(k, v)| (k.clone(), v.last_used_ms))
            .collect()
    };
    let mut sorted = items;
    sorted.sort_by_key(|(_, ts)| *ts);
    let mut to_remove: Vec<String> = Vec::new();
    for (cid, last) in sorted.into_iter() {
        let cur = { REGISTRY.lock().await.by_cid.len() };
        if cur.saturating_sub(to_remove.len()) <= max_children {
            break;
        }
        if now.saturating_sub(last) > idle_ms_thresh {
            to_remove.push(cid);
        }
    }
    let handles: Vec<Arc<CodexClient>> = {
        let mut guard = REGISTRY.lock().await;
        to_remove
            .iter()
            .filter_map(|cid| guard.by_cid.remove(cid).map(|h| h.client))
            .collect()
    };
    for client in handles.into_iter() {
        let _ = client.terminate().await;
    }
}

/// 初始化后台 GC 循环（可选，缺省开启）。
pub fn init_gc() {
    let interval_ms: u64 = std::env::var("AILOOM_CODEX_CHILD_GC_INTERVAL_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(5_000);
    if interval_ms == 0 {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
            gc_if_needed().await;
        }
    });
}

#[derive(serde::Serialize)]
pub struct ChildSnapshot {
    pub conversation_id: String,
    pub pid: Option<u32>,
    pub last_used_ms: u64,
    pub idle_ms: u64,
}

pub async fn snapshot() -> Vec<ChildSnapshot> {
    let now = now_millis();
    let items: Vec<ChildHandle> = {
        let guard = REGISTRY.lock().await;
        guard.by_cid.values().cloned().collect()
    };
    let mut out = Vec::new();
    for h in items.into_iter() {
        let pid = h.client.pid().await;
        let idle = now.saturating_sub(h.last_used_ms);
        out.push(ChildSnapshot {
            conversation_id: h.conversation_id.clone(),
            pid,
            last_used_ms: h.last_used_ms,
            idle_ms: idle.max(0),
        });
    }
    out
}

/// 查询是否已有该会话的子进程（per-conv）。
pub async fn has_child(conversation_id: &str) -> bool {
    let guard = REGISTRY.lock().await;
    guard.by_cid.contains_key(conversation_id)
}

pub async fn interrupt_conversation(
    workspace_root: PathBuf,
    hub: Option<Hub>,
    conversation_id: &str,
) -> Result<()> {
    if !is_per_conv_mode() {
        let client = app_server::get_or_start(Some(workspace_root.clone())).await?;
        if let Some(h) = hub.clone() {
            client.register_ws_hub(h);
        }
        let app = client.app();
        let _ = app
            .interrupt_conversation(conversation_id.to_string())
            .await?;
        return Ok(());
    }
    // 若有现成 handle，直发；否则先 ensure（可能 resume），再发
    let maybe_handle = {
        let guard = REGISTRY.lock().await;
        guard.get(conversation_id)
    };
    if let Some(handle) = maybe_handle {
        let app = handle.client.app();
        let _ = app
            .interrupt_conversation(conversation_id.to_string())
            .await?;
        return Ok(());
    }
    ensure_listener(workspace_root, hub, conversation_id).await?;
    let maybe_handle = {
        let guard = REGISTRY.lock().await;
        guard.get(conversation_id)
    };
    if let Some(handle) = maybe_handle {
        let app = handle.client.app();
        let _ = app
            .interrupt_conversation(conversation_id.to_string())
            .await?;
        return Ok(());
    }
    Err(anyhow!("interrupt: handle not available after ensure"))
}

pub async fn hard_kill(conversation_id: &str) -> Result<()> {
    if !is_per_conv_mode() {
        // 单例模式下不支持硬杀单会话子进程；忽略
        return Ok(());
    }
    let maybe = {
        let mut guard = REGISTRY.lock().await;
        guard.by_cid.remove(conversation_id)
    };
    if let Some(h) = maybe {
        let _ = h.client.terminate().await;
        return Ok(());
    }
    Ok(())
}
