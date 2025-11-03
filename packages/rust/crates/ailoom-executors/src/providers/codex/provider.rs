use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use codex_app_server_protocol::{
    InputItem, NewConversationParams, ResumeConversationParams, SendUserTurnParams,
};
use codex_protocol::{
    config_types::{ReasoningEffort, ReasoningSummary, SandboxMode},
    protocol::{AskForApproval, SandboxPolicy},
    ConversationId,
};
use serde_json::{json, Map, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::sync::{mpsc, Mutex};
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
    turn: CurrentTurnConfig,
}

#[derive(Clone)]
struct CurrentTurnConfig {
    model: Option<String>,
    approval_policy: AskForApproval,
    sandbox_policy: SandboxPolicy,
    cwd: PathBuf,
    effort: Option<ReasoningEffort>,
    summary: ReasoningSummary,
}

impl CurrentTurnConfig {
    fn new(
        cwd: PathBuf,
        model: Option<String>,
        approval_policy: Option<AskForApproval>,
        sandbox_mode: Option<SandboxMode>,
        effort: Option<ReasoningEffort>,
    ) -> Self {
        let approval = approval_policy.unwrap_or(AskForApproval::OnRequest);
        let sandbox_policy = match sandbox_mode {
            Some(SandboxMode::DangerFullAccess) => SandboxPolicy::DangerFullAccess,
            Some(SandboxMode::ReadOnly) => SandboxPolicy::new_read_only_policy(),
            Some(SandboxMode::WorkspaceWrite) => SandboxPolicy::new_workspace_write_policy(),
            None => SandboxPolicy::new_workspace_write_policy(),
        };
        Self {
            model,
            approval_policy: approval,
            sandbox_policy,
            cwd,
            effort,
            summary: ReasoningSummary::Auto,
        }
    }

    fn update_from_resume(
        cwd: PathBuf,
        model: Option<String>,
        effort: Option<ReasoningEffort>,
    ) -> Self {
        Self {
            model,
            approval_policy: AskForApproval::OnRequest,
            sandbox_policy: SandboxPolicy::new_workspace_write_policy(),
            cwd,
            effort,
            summary: ReasoningSummary::Auto,
        }
    }

    fn merged_with_turn(
        &self,
        conversation_id: &str,
        turn: &crate::ConversationTurn,
    ) -> Result<(Self, SendUserTurnParams), ProviderError> {
        let mut next = self.clone();

        if let Some(cwd_override) = turn.cwd.clone() {
            if !cwd_override.as_os_str().is_empty() {
                next.cwd = cwd_override;
            }
        }

        if let Some(model_override) = normalize_string(turn.model.clone()) {
            next.model = Some(model_override);
        }

        if let Some(approval) = turn.approval_policy {
            next.approval_policy = approval;
        }

        if let Some(effort) = turn.effort {
            next.effort = Some(effort);
        }

        if let Some(summary) = turn.summary.clone() {
            next.summary = summary;
        }

        if let Some(sandbox) = &turn.sandbox {
            next.sandbox_policy = merge_sandbox_policy(&next.sandbox_policy, sandbox, &next.cwd);
        }

        let model = next.model.clone().ok_or_else(|| {
            ProviderError::InvalidRequest("model is required for send_user_turn".into())
        })?;

        let conversation_id = ConversationId::from_string(conversation_id)
            .map_err(|e| ProviderError::InvalidRequest(format!("invalid conversation id: {e}")))?;

        let params = SendUserTurnParams {
            conversation_id,
            items: vec![InputItem::Text {
                text: turn.text.clone(),
            }],
            cwd: next.cwd.clone(),
            approval_policy: next.approval_policy,
            sandbox_policy: next.sandbox_policy.clone(),
            model,
            effort: next.effort,
            summary: next.summary,
        };

        Ok((next, params))
    }
}

fn normalize_string(input: Option<String>) -> Option<String> {
    input.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn merge_sandbox_policy(
    current: &SandboxPolicy,
    overrides: &crate::SandboxOverrides,
    cwd: &Path,
) -> SandboxPolicy {
    match overrides.mode {
        SandboxMode::DangerFullAccess => SandboxPolicy::DangerFullAccess,
        SandboxMode::ReadOnly => SandboxPolicy::new_read_only_policy(),
        SandboxMode::WorkspaceWrite => {
            let mut writable_roots =
                overrides
                    .writable_roots
                    .clone()
                    .unwrap_or_else(|| match current {
                        SandboxPolicy::WorkspaceWrite { writable_roots, .. } => {
                            writable_roots.clone()
                        }
                        _ => Vec::new(),
                    });
            if writable_roots.is_empty() {
                writable_roots.push(cwd.to_path_buf());
            }
            let (network_access_default, exclude_tmpdir_default, exclude_slash_tmp_default) =
                match current {
                    SandboxPolicy::WorkspaceWrite {
                        network_access,
                        exclude_tmpdir_env_var,
                        exclude_slash_tmp,
                        ..
                    } => (*network_access, *exclude_tmpdir_env_var, *exclude_slash_tmp),
                    _ => (false, false, false),
                };
            SandboxPolicy::WorkspaceWrite {
                writable_roots,
                network_access: overrides.network_access.unwrap_or(network_access_default),
                exclude_tmpdir_env_var: overrides
                    .exclude_tmpdir_env_var
                    .unwrap_or(exclude_tmpdir_default),
                exclude_slash_tmp: overrides
                    .exclude_slash_tmp
                    .unwrap_or(exclude_slash_tmp_default),
            }
        }
    }
}

struct RuntimeObserverImpl {
    generating: Arc<Mutex<HashMap<String, bool>>>,
    hub: Option<SharedEventHub>,
    touch_tx: mpsc::UnboundedSender<String>,
}

impl RuntimeObserverImpl {
    fn new(
        generating: Arc<Mutex<HashMap<String, bool>>>,
        hub: Option<SharedEventHub>,
        touch_tx: mpsc::UnboundedSender<String>,
    ) -> Self {
        Self {
            generating,
            hub,
            touch_tx,
        }
    }

    pub(crate) fn set(&self, conversation_id: &str, generating: bool) {
        let conversation_id = conversation_id.to_string();
        let generating_map = self.generating.clone();
        let hub = self.hub.clone();
        let touch_tx = self.touch_tx.clone();
        tokio::spawn(async move {
            let _ = touch_tx.send(conversation_id.clone());
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
            "chat.message.delta"
            | "chat.reasoning.delta"
            | "chat.tool.exec.begin"
            | "chat.tool.exec.output"
            | "chat.tool.exec.end"
            | "chat.tool.patch.begin"
            | "chat.tool.patch.end"
            | "chat.tool.mcp.begin"
            | "chat.tool.mcp.end"
            | "chat.info.plan_update" => self.set(cid, true),
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
    ensure_guards: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
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
        let (touch_tx, touch_rx) = mpsc::unbounded_channel();
        let runtime_observer = Arc::new(RuntimeObserverImpl::new(
            generating.clone(),
            hub.clone(),
            touch_tx,
        ));
        let provider = Arc::new(Self {
            workspace_root,
            hub,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            max_children,
            idle_ms_threshold,
            gc_interval_ms,
            generating,
            runtime_observer,
            ensure_guards: Arc::new(Mutex::new(HashMap::new())),
        });
        provider.spawn_background_tasks();
        provider.spawn_touch_worker(touch_rx);
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

    fn spawn_touch_worker(self: &Arc<Self>, mut rx: mpsc::UnboundedReceiver<String>) {
        let provider = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(conversation_id) = rx.recv().await {
                provider.mark_used(&conversation_id).await;
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

    async fn drop_handle_with_reason(
        &self,
        conversation_id: &str,
        reason: &str,
    ) -> Option<SessionHandle> {
        if let Some(handle) = self.remove_handle(conversation_id).await {
            self.broadcast_child_down(&handle, conversation_id, reason)
                .await;
            Some(handle)
        } else {
            None
        }
    }

    async fn alive_handles(&self) -> Vec<(String, SessionHandle)> {
        let snapshot: Vec<(String, SessionHandle)> = {
            let guard = self.sessions.lock().await;
            guard
                .iter()
                .map(|(cid, handle)| (cid.clone(), handle.clone()))
                .collect()
        };
        if snapshot.is_empty() {
            return Vec::new();
        }

        let mut alive = Vec::with_capacity(snapshot.len());
        for (cid, handle) in snapshot.into_iter() {
            if handle.client.is_alive().await {
                alive.push((cid, handle));
            } else {
                self.drop_handle_with_reason(&cid, "process_gone").await;
            }
        }
        alive
    }

    async fn conversation_mutex(&self, conversation_id: &str) -> Arc<Mutex<()>> {
        let mut guard = self.ensure_guards.lock().await;
        guard
            .entry(conversation_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
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
        let convo_lock = self.conversation_mutex(conversation_id).await;
        let _guard = convo_lock.lock().await;
        if let Some(mut handle) = self.handle(conversation_id).await {
            if handle.client.is_alive().await {
                let app = handle.client.app();
                app.ensure_listener_resilient(conversation_id)
                    .await
                    .map_err(|e| ProviderError::Other(e.to_string()))?;
                handle.last_used_ms = Self::now_millis();
                self.insert_handle(conversation_id.to_string(), handle)
                    .await;
                return Ok(());
            } else {
                self.drop_handle_with_reason(conversation_id, "process_gone")
                    .await;
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
        let path = lookup_path_by_conversation_id(Some(app.clone()), conversation_id)
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
                turn: CurrentTurnConfig::update_from_resume(
                    workspace_root.to_path_buf(),
                    Some(resp.model.clone()),
                    None,
                ),
            },
        ))
    }

    async fn gc_tick(&self) {
        let handles = self.alive_handles().await;
        if handles.is_empty() {
            return;
        }

        let now = Self::now_millis();
        let generating_map = {
            let guard = self.generating.lock().await;
            guard.clone()
        };
        let mut to_remove: Vec<(String, SessionHandle)> = handles
            .iter()
            .filter(|(cid, handle)| {
                if generating_map.get(cid).copied().unwrap_or(false) {
                    return false;
                }
                now.saturating_sub(handle.last_used_ms) > self.idle_ms_threshold
            })
            .cloned()
            .collect();

        if handles.len() > self.max_children {
            let mut sorted = handles.clone();
            sorted.sort_by_key(|(_, handle)| handle.last_used_ms);
            for item in sorted.into_iter() {
                if generating_map.get(&item.0).copied().unwrap_or(false) {
                    continue;
                }
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

        for (cid, _) in to_remove.into_iter() {
            if let Some(handle) = self.drop_handle_with_reason(&cid, "idle_gc").await {
                let _ = handle.client.terminate().await;
            }
        }
    }

    async fn broadcast_session_runtime(&self) {
        if let Some(h) = &self.hub {
            let handles = self.alive_handles().await;
            if handles.is_empty() {
                return;
            }
            let now = Self::now_millis();
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
        let spawn_params = params.clone();
        let app = client.app();
        let resp = app
            .new_conversation(spawn_params)
            .await
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        let conversation_id = resp.conversation_id.to_string();
        app.ensure_listener_resilient(&conversation_id)
            .await
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        let turn_config = CurrentTurnConfig::new(
            workspace_root.clone(),
            Some(resp.model.clone()),
            params.approval_policy,
            params.sandbox,
            resp.reasoning_effort,
        );
        let handle = SessionHandle {
            client: client.clone(),
            cwd: workspace_root.clone(),
            created_ms: Self::now_millis(),
            last_used_ms: Self::now_millis(),
            turn: turn_config,
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

    async fn send_user_turn(
        &self,
        conversation_id: &str,
        turn: crate::ConversationTurn,
    ) -> Result<(), ProviderError> {
        self.ensure_internal(conversation_id).await?;
        if let Some(mut handle) = self.handle(conversation_id).await {
            let (next_config, params) = handle.turn.merged_with_turn(conversation_id, &turn)?;
            let app = handle.client.app();
            app.send_user_turn(params)
                .await
                .map_err(|e| ProviderError::Other(e.to_string()))?;
            handle.turn = next_config;
            handle.last_used_ms = Self::now_millis();
            self.insert_handle(conversation_id.to_string(), handle)
                .await;
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
        if let Some(handle) = self
            .drop_handle_with_reason(conversation_id, "terminate")
            .await
        {
            handle.client.terminate().await;
            Ok(())
        } else {
            Ok(())
        }
    }

    async fn is_alive(&self, conversation_id: &str) -> Result<bool, ProviderError> {
        if let Some(handle) = self.handle(conversation_id).await {
            if handle.client.is_alive().await {
                Ok(true)
            } else {
                self.drop_handle_with_reason(conversation_id, "process_gone")
                    .await;
                Ok(false)
            }
        } else {
            Ok(false)
        }
    }

    async fn runtime_snapshots(&self) -> Vec<RuntimeSnapshot> {
        let handles = self.alive_handles().await;
        let generating_map = {
            let guard = self.generating.lock().await;
            guard.clone()
        };
        let mut out = Vec::with_capacity(handles.len());
        let now = Self::now_millis();
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
