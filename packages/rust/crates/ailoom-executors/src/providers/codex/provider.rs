use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use codex_app_server_protocol::{NewConversationParams, ResumeConversationParams};
use codex_protocol::protocol::AskForApproval;
use serde_json::{json, Map, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};

use super::{
    app_server::CodexClient, bridge::store_conversation_id, client::RuntimeEventObserver,
    lookup::lookup_path_by_conversation_id,
};
use crate::{
    ProviderError, RuntimeSnapshot, RuntimeStatus, SharedEventHub, SpawnConfig, StandardProvider,
};

#[derive(Clone)]
struct SessionHandle {
    client: Arc<CodexClient>,
    cwd: PathBuf,
    created_ms: u64,
    last_used_ms: u64,
}

struct RuntimeObserverImpl {
    generating: Arc<Mutex<HashMap<String, bool>>>,
    hub: Option<SharedEventHub>,
}

impl RuntimeObserverImpl {
    fn new(generating: Arc<Mutex<HashMap<String, bool>>>, hub: Option<SharedEventHub>) -> Self {
        Self { generating, hub }
    }

    pub(crate) fn set(&self, conversation_id: &str, generating: bool) {
        let conversation_id = conversation_id.to_string();
        let generating_map = self.generating.clone();
        let hub = self.hub.clone();
        tokio::spawn(async move {
            let mut guard = generating_map.lock().await;
            let previous = guard.get(&conversation_id).copied().unwrap_or(false);
            if generating {
                guard.insert(conversation_id.clone(), true);
            } else {
                guard.remove(&conversation_id);
            }
            drop(guard);
            if previous == generating {
                return;
            }
            if let Some(h) = hub {
                let mut payload = Map::new();
                payload.insert("provider".into(), json!("codex"));
                payload.insert("conversationId".into(), json!(conversation_id));
                payload.insert("generating".into(), json!(generating));
                payload.insert("ts".into(), json!(Self::now_rfc3339()));
                h.broadcast(
                    "chat.info.runtime.generating".into(),
                    Value::Object(payload),
                );
            }
        });
    }

    fn now_rfc3339() -> String {
        OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_else(|_| "".into())
    }
}

impl RuntimeEventObserver for RuntimeObserverImpl {
    fn on_runtime_event(&self, method: &str, params: &Value) {
        let cid = params
            .get("conversationId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if cid.is_empty() {
            return;
        }
        match method {
            "chat.turn.started" => self.set(cid, true),
            "chat.message.completed"
            | "chat.message.failed"
            | "chat.message.aborted"
            | "chat.turn.complete" => self.set(cid, false),
            "chat.info.runtime.generating" => {
                let value = params
                    .get("generating")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                self.set(cid, value);
            }
            _ => {}
        }
    }
}

#[derive(Clone)]
pub struct CodexProvider {
    workspace_root: PathBuf,
    hub: Option<SharedEventHub>,
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
    max_children: usize,
    idle_ms_threshold: u64,
    gc_interval_ms: u64,
    generating: Arc<Mutex<HashMap<String, bool>>>,
    runtime_observer: Arc<RuntimeObserverImpl>,
}

impl CodexProvider {
    pub fn new(workspace_root: PathBuf, hub: Option<SharedEventHub>) -> Arc<Self> {
        let max_children = std::env::var("AILOOM_EXEC_MAX_CHILDREN")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(6);
        let idle_ms_threshold = std::env::var("AILOOM_EXEC_IDLE_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(60_000);
        let gc_interval_ms = std::env::var("AILOOM_EXEC_GC_INTERVAL_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(5_000);

        let generating = Arc::new(Mutex::new(HashMap::new()));
        let runtime_observer = Arc::new(RuntimeObserverImpl::new(generating.clone(), hub.clone()));
        let provider = Arc::new(Self {
            workspace_root,
            hub,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            max_children,
            idle_ms_threshold,
            gc_interval_ms,
            generating,
            runtime_observer,
        });
        provider.spawn_background_tasks();
        provider
    }

    fn spawn_background_tasks(self: &Arc<Self>) {
        if self.gc_interval_ms == 0 {
            return;
        }
        let provider = Arc::clone(self);
        tokio::spawn(async move {
            let interval = Duration::from_millis(provider.gc_interval_ms);
            loop {
                sleep(interval).await;
                provider.gc_tick().await;
                provider.broadcast_session_runtime().await;
            }
        });
    }

    fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    fn now_rfc3339() -> String {
        OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_else(|_| "".into())
    }

    fn workspace_root(&self, override_root: Option<&Path>) -> PathBuf {
        override_root
            .filter(|p| p.components().count() > 0)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| self.workspace_root.clone())
    }

    async fn codex_client(&self, workspace_root: &Path) -> Result<Arc<CodexClient>, ProviderError> {
        let client = CodexClient::start(Some(workspace_root.to_path_buf()))
            .await
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        if let Some(h) = self.hub.clone() {
            client.register_event_hub(h);
        }
        client
            .app()
            .register_runtime_observer(self.runtime_observer.clone());
        Ok(client)
    }

    async fn broadcast_child_event(
        &self,
        method: &str,
        conversation_id: &str,
        pid: Option<u32>,
        reason: Option<&str>,
    ) {
        if let Some(h) = &self.hub {
            let mut map = Map::new();
            map.insert("provider".into(), json!("codex"));
            map.insert("conversationId".into(), json!(conversation_id));
            if let Some(pid) = pid {
                map.insert("pid".into(), json!(pid));
            }
            if let Some(reason) = reason {
                map.insert("reason".into(), json!(reason));
            }
            map.insert("ts".into(), json!(Self::now_rfc3339()));
            h.broadcast(method.to_string(), Value::Object(map));
        }
    }

    async fn broadcast_child_up(&self, conversation_id: &str, reason: &str) {
        if let Some(handle) = self.sessions.lock().await.get(conversation_id).cloned() {
            let pid = handle.client.pid().await;
            self.broadcast_child_event(
                "chat.info.runtime.child_up",
                conversation_id,
                pid,
                Some(reason),
            )
            .await;
        }
    }

    async fn broadcast_child_down(
        &self,
        handle: &SessionHandle,
        conversation_id: &str,
        reason: &str,
    ) {
        let pid = handle.client.pid().await;
        self.broadcast_child_event(
            "chat.info.runtime.child_down",
            conversation_id,
            pid,
            Some(reason),
        )
        .await;
    }

    async fn insert_handle(&self, conversation_id: String, handle: SessionHandle) {
        let mut guard = self.sessions.lock().await;
        guard.insert(conversation_id.clone(), handle);
        drop(guard);
        self.runtime_observer.set(&conversation_id, false);
    }

    async fn remove_handle(&self, conversation_id: &str) -> Option<SessionHandle> {
        let mut guard = self.sessions.lock().await;
        let removed = guard.remove(conversation_id);
        drop(guard);
        self.runtime_observer.set(conversation_id, false);
        removed
    }

    async fn handle(&self, conversation_id: &str) -> Option<SessionHandle> {
        let guard = self.sessions.lock().await;
        guard.get(conversation_id).cloned()
    }

    async fn mark_used(&self, conversation_id: &str) {
        let mut guard = self.sessions.lock().await;
        if let Some(handle) = guard.get_mut(conversation_id) {
            handle.last_used_ms = Self::now_millis();
        }
    }

    fn build_params(&self, config: SpawnConfig, cwd: &Path) -> NewConversationParams {
        let mut params = NewConversationParams::default();
        params.cwd = Some(cwd.to_string_lossy().to_string());
        if let Some(model) = config.model {
            params.model = Some(model);
        }
        if let Value::Object(mut obj) = config.options {
            if let Some(value) = obj.remove("approvalPolicy") {
                if let Ok(policy) = serde_json::from_value::<AskForApproval>(value) {
                    params.approval_policy = Some(policy);
                }
            }
            if let Some(value) = obj.remove("sandbox") {
                params.sandbox = serde_json::from_value(value).ok();
            }
            if let Some(value) = obj.remove("profile") {
                params.profile = serde_json::from_value(value).ok();
            }
            if !obj.is_empty() {
                params.config = Some(obj.into_iter().collect());
            }
        }
        params
    }

    async fn ensure_internal(&self, conversation_id: &str) -> Result<(), ProviderError> {
        if let Some(mut handle) = self.handle(conversation_id).await {
            if !handle.client.is_alive().await {
                self.remove_handle(conversation_id).await;
            } else {
                let app = handle.client.app();
                app.ensure_listener_resilient(conversation_id)
                    .await
                    .map_err(|e| ProviderError::Other(e.to_string()))?;
                handle.last_used_ms = Self::now_millis();
                self.insert_handle(conversation_id.to_string(), handle)
                    .await;
                return Ok(());
            }
        }

        let workspace_root = self.workspace_root(None);
        let client = self.codex_client(&workspace_root).await?;
        let (cid, handle) = self
            .resume_and_attach(client, conversation_id, &workspace_root)
            .await?;
        self.insert_handle(cid.clone(), handle).await;
        self.broadcast_child_up(&cid, "ensure").await;
        self.gc_tick().await;
        Ok(())
    }

    async fn resume_and_attach(
        &self,
        client: Arc<CodexClient>,
        conversation_id: &str,
        workspace_root: &Path,
    ) -> Result<(String, SessionHandle), ProviderError> {
        let app = client.app();
        let path = lookup_path_by_conversation_id(&app, conversation_id)
            .await
            .ok_or_else(|| {
                ProviderError::Other(format!(
                    "conversation {} rollout path not found",
                    conversation_id
                ))
            })?;
        let params = ResumeConversationParams {
            path: Some(PathBuf::from(path)),
            conversation_id: None,
            history: None,
            overrides: Some(NewConversationParams {
                cwd: Some(workspace_root.to_string_lossy().to_string()),
                ..Default::default()
            }),
        };
        let resp = app
            .resume_conversation(params)
            .await
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        let cid = resp.conversation_id.to_string();
        app.ensure_listener_resilient(&cid)
            .await
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        store_conversation_id(&cid);
        Ok((
            cid,
            SessionHandle {
                client,
                cwd: workspace_root.to_path_buf(),
                created_ms: Self::now_millis(),
                last_used_ms: Self::now_millis(),
            },
        ))
    }

    async fn gc_tick(&self) {
        let now = Self::now_millis();
        let handles: Vec<(String, SessionHandle)> = {
            let guard = self.sessions.lock().await;
            guard
                .iter()
                .map(|(cid, handle)| (cid.clone(), handle.clone()))
                .collect()
        };
        if handles.is_empty() {
            return;
        }

        let mut to_remove: Vec<(String, SessionHandle)> = handles
            .iter()
            .filter(|(_, handle)| now.saturating_sub(handle.last_used_ms) > self.idle_ms_threshold)
            .cloned()
            .collect();

        if handles.len() > self.max_children {
            let mut sorted = handles.clone();
            sorted.sort_by_key(|(_, handle)| handle.last_used_ms);
            for item in sorted.into_iter() {
                if to_remove.iter().any(|(cid, _)| cid == &item.0) {
                    continue;
                }
                if handles.len().saturating_sub(to_remove.len()) <= self.max_children {
                    break;
                }
                to_remove.push(item);
            }
        }

        if to_remove.is_empty() {
            return;
        }

        {
            let mut guard = self.sessions.lock().await;
            for (cid, _) in to_remove.iter() {
                guard.remove(cid);
            }
        }

        for (cid, handle) in to_remove.into_iter() {
            self.runtime_observer.set(&cid, false);
            self.broadcast_child_down(&handle, &cid, "idle_gc").await;
            let _ = handle.client.terminate().await;
        }
    }

    async fn broadcast_session_runtime(&self) {
        if let Some(h) = &self.hub {
            let now = Self::now_millis();
            let handles: Vec<(String, SessionHandle)> = {
                let guard = self.sessions.lock().await;
                guard
                    .iter()
                    .map(|(cid, handle)| (cid.clone(), handle.clone()))
                    .collect()
            };
            if handles.is_empty() {
                return;
            }
            let generating_map = {
                let guard = self.generating.lock().await;
                guard.clone()
            };
            let mut items = Vec::new();
            for (cid, handle) in handles.into_iter() {
                let idle_ms = now.saturating_sub(handle.last_used_ms);
                let pid = handle.client.pid().await;
                let generating = generating_map.get(&cid).copied().unwrap_or(false);
                let status = if generating {
                    "running"
                } else if idle_ms > 0 {
                    "idle"
                } else {
                    "running"
                };
                items.push(json!({
                    "provider": "codex",
                    "conversationId": cid,
                    "status": status,
                    "idleMs": idle_ms,
                    "pid": pid,
                    "generating": generating,
                }));
            }
            let payload = json!({
                "items": items,
                "ts": Self::now_rfc3339(),
            });
            h.broadcast_ephemeral("session.runtime".into(), payload);
        }
    }
}

#[async_trait]
impl StandardProvider for CodexProvider {
    fn id(&self) -> &'static str {
        "codex"
    }

    async fn new_conversation(&self, config: SpawnConfig) -> Result<String, ProviderError> {
        let workspace_root = self.workspace_root(None);
        let client = self.codex_client(&workspace_root).await?;
        let params = self.build_params(config, &workspace_root);
        let app = client.app();
        let resp = app
            .new_conversation(params)
            .await
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        let conversation_id = resp.conversation_id.to_string();
        app.ensure_listener_resilient(&conversation_id)
            .await
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        let handle = SessionHandle {
            client: client.clone(),
            cwd: workspace_root.clone(),
            created_ms: Self::now_millis(),
            last_used_ms: Self::now_millis(),
        };
        self.insert_handle(conversation_id.clone(), handle).await;
        store_conversation_id(&conversation_id);
        self.broadcast_child_up(&conversation_id, "spawn").await;
        self.gc_tick().await;
        Ok(conversation_id)
    }

    async fn ensure_listener(&self, conversation_id: &str) -> Result<(), ProviderError> {
        self.ensure_internal(conversation_id).await
    }

    async fn send_user_message(
        &self,
        conversation_id: &str,
        text: &str,
    ) -> Result<(), ProviderError> {
        self.ensure_internal(conversation_id).await?;
        if let Some(handle) = self.handle(conversation_id).await {
            let app = handle.client.app();
            app.send_user_message(conversation_id.to_string(), text.to_string())
                .await
                .map_err(|e| ProviderError::Other(e.to_string()))?;
            self.mark_used(conversation_id).await;
            Ok(())
        } else {
            Err(ProviderError::Unavailable(format!(
                "conversation {:?} not available",
                conversation_id
            )))
        }
    }

    async fn interrupt(&self, conversation_id: &str) -> Result<(), ProviderError> {
        if let Some(handle) = self.handle(conversation_id).await {
            handle
                .client
                .app()
                .interrupt_conversation(conversation_id.to_string())
                .await
                .map(|_| ())
                .map_err(|e| ProviderError::Other(e.to_string()))
        } else {
            Err(ProviderError::Unavailable(format!(
                "conversation {:?} not available",
                conversation_id
            )))
        }
    }

    async fn terminate(&self, conversation_id: &str) -> Result<(), ProviderError> {
        if let Some(handle) = self.remove_handle(conversation_id).await {
            self.broadcast_child_down(&handle, conversation_id, "terminate")
                .await;
            handle.client.terminate().await;
            Ok(())
        } else {
            Ok(())
        }
    }

    async fn is_alive(&self, conversation_id: &str) -> Result<bool, ProviderError> {
        Ok(self.handle(conversation_id).await.is_some())
    }

    async fn runtime_snapshots(&self) -> Vec<RuntimeSnapshot> {
        let now = Self::now_millis();
        let handles: Vec<(String, SessionHandle)> = {
            let guard = self.sessions.lock().await;
            guard
                .iter()
                .map(|(cid, handle)| (cid.clone(), handle.clone()))
                .collect()
        };
        let generating_map = {
            let guard = self.generating.lock().await;
            guard.clone()
        };
        let mut out = Vec::with_capacity(handles.len());
        for (cid, handle) in handles.into_iter() {
            let idle_ms = now.saturating_sub(handle.last_used_ms);
            let pid = handle.client.pid().await;
            let generating = generating_map.get(&cid).copied().unwrap_or(false);
            let status = if generating {
                RuntimeStatus::Running
            } else if idle_ms > 0 {
                RuntimeStatus::Idle
            } else {
                RuntimeStatus::Running
            };
            out.push(RuntimeSnapshot {
                provider: "codex".into(),
                conversation_id: cid,
                status,
                idle_ms,
                pid,
                generating,
            });
        }
        out
    }
}
