use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Result};
use codex_app_server_protocol::{
    AddConversationListenerParams, AddConversationSubscriptionResponse, ApplyPatchApprovalResponse,
    ClientInfo, ClientNotification, GetUserSavedConfigResponse, InitializeParams,
    InitializeResponse, InterruptConversationParams, InterruptConversationResponse, JSONRPCError,
    JSONRPCNotification, JSONRPCRequest, JSONRPCResponse, ListConversationsParams,
    ListConversationsResponse, ListModelsParams, ListModelsResponse, NewConversationParams,
    NewConversationResponse, RemoveConversationListenerParams,
    RemoveConversationSubscriptionResponse, RequestId, ResumeConversationParams,
    ResumeConversationResponse, SendUserMessageParams, SendUserMessageResponse, ServerRequest,
};
use codex_app_server_protocol::{ExecCommandApprovalResponse, InputItem};
use codex_protocol::protocol::ReviewDecision;
use codex_protocol::ConversationId;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;
use tracing::instrument;

use crate::SharedEventHub;

use super::bridge::{
    active_conversation_ids, map_notification, map_notification_to_chat_events, BroadcastEvent,
};
use super::transport::{JsonRpcCallbacks, JsonRpcPeer};

pub trait RuntimeEventObserver: Send + Sync {
    fn on_runtime_event(&self, method: &str, params: &Value);
}

#[derive(Clone)]
pub struct AppServerClient {
    rpc: OnceLock<JsonRpcPeer>,
    hub: Arc<Mutex<Option<SharedEventHub>>>,
    // conversation_id -> (subscription_id, refcount)
    subscriptions: Arc<Mutex<HashMap<String, (uuid::Uuid, usize)>>>,
    // 强自愈：额外叠加的“并行监听”订阅（可能存在多个 sub_id）
    extra_subscriptions: Arc<Mutex<HashMap<String, Vec<uuid::Uuid>>>>,
    // best-effort active set; used for lifecycle hints (release on shutdown)
    active_conversations: Arc<Mutex<HashSet<String>>>,
    // 每会话监听的并发门闩：避免重复 addConversationListener
    listener_guards: Arc<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
    runtime_observer: Arc<Mutex<Option<Arc<dyn RuntimeEventObserver>>>>,
}

impl AppServerClient {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            rpc: OnceLock::new(),
            hub: Arc::new(Mutex::new(None)),
            subscriptions: Arc::new(Mutex::new(HashMap::new())),
            extra_subscriptions: Arc::new(Mutex::new(HashMap::new())),
            active_conversations: Arc::new(Mutex::new(HashSet::new())),
            listener_guards: Arc::new(Mutex::new(HashMap::new())),
            runtime_observer: Arc::new(Mutex::new(None)),
        })
    }

    pub fn connect(&self, peer: JsonRpcPeer) {
        let _ = self.rpc.set(peer);
    }

    pub async fn restore_active_conversation_listeners(&self) {
        let active = active_conversation_ids();
        if active.is_empty() {
            return;
        }
        for conversation_id in active {
            if let Err(err) = self.ensure_listener(&conversation_id).await {
                tracing::warn!(
                    target: "codex",
                    conversationId = %conversation_id,
                    error = %err,
                    "restore_active_conversation_listeners: ensure_listener 失败"
                );
            }
        }
    }

    fn rpc(&self) -> &JsonRpcPeer {
        self.rpc.get().expect("Codex RPC peer not attached")
    }

    pub fn register_event_hub(&self, hub: SharedEventHub) {
        *self.hub.lock().unwrap() = Some(hub);
    }

    pub fn register_runtime_observer(&self, observer: Arc<dyn RuntimeEventObserver>) {
        *self.runtime_observer.lock().unwrap() = Some(observer);
    }

    /// 调试/观测：返回 (conversationId, refCount) 列表的快照
    pub fn subscriptions_snapshot(&self) -> Vec<(String, usize)> {
        let guard = self.subscriptions.lock().unwrap();
        guard
            .iter()
            .map(|(k, (_id, cnt))| (k.clone(), *cnt))
            .collect()
    }

    /// 调试/观测：返回 active_conversations 集合快照
    pub fn active_conversations_snapshot(&self) -> Vec<String> {
        let guard = self.active_conversations.lock().unwrap();
        guard.iter().cloned().collect()
    }

    /// 是否已收到该会话的 sessionConfigured（基于 on_notification 维护的活动集）。
    pub fn is_session_active(&self, conversation_id: &str) -> bool {
        let guard = self.active_conversations.lock().unwrap();
        guard.contains(conversation_id)
    }

    /// 最多等待一段时间，直到收到 sessionConfigured（活动集包含该会话）。
    pub async fn wait_for_session_configured(
        &self,
        conversation_id: &str,
        max_wait_ms: u64,
        step_ms: u64,
    ) -> bool {
        if self.is_session_active(conversation_id) {
            return true;
        }
        let mut waited = 0u64;
        while waited < max_wait_ms {
            if self.is_session_active(conversation_id) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(step_ms)).await;
            waited += step_ms;
        }
        false
    }

    /// 强自愈：在已存在监听的情况下，再叠加一条监听（不移除旧监听）。
    /// 仅当环境变量 AILOOM_CODEX_STRONG_SELF_HEAL=1 时建议调用。
    pub async fn force_add_listener(&self, conversation_id: &str) -> Result<()> {
        let resp = self
            .add_conversation_listener(conversation_id.to_string())
            .await?;
        let sub_id = resp.subscription_id;
        let mut guard = self.extra_subscriptions.lock().unwrap();
        guard
            .entry(conversation_id.to_string())
            .or_default()
            .push(sub_id);
        Ok(())
    }

    #[instrument(level = "info", target = "codex.rpc", skip(self))]
    pub async fn initialize(&self) -> Result<InitializeResponse> {
        let params = InitializeParams {
            client_info: ClientInfo {
                name: "ailoom".into(),
                title: Some("AI Loom".into()),
                version: env!("CARGO_PKG_VERSION").into(),
            },
        };
        let id = self.rpc().next_request_id();
        let request = JSONRPCRequest {
            id: id.clone(),
            method: "initialize".into(),
            params: Some(serde_json::to_value(params)?),
        };
        let response: InitializeResponse = self.rpc().request(request, "initialize").await?;
        // 与官方握手一致：完成后发送 initialized 通知
        let notification = client_notification(ClientNotification::Initialized)?;
        self.rpc().send_notification(notification).await?;
        Ok(response)
    }

    /// Ensure a single listener is registered per conversation; increments a refcount.
    pub async fn ensure_listener(&self, conversation_id: &str) -> Result<()> {
        // fast path: already subscribed
        {
            let mut guard = self.subscriptions.lock().unwrap();
            if let Some((_sub_id, refcnt)) = guard.get_mut(conversation_id) {
                *refcnt = refcnt.saturating_add(1);
                return Ok(());
            }
        }

        // register a new listener
        let resp = self
            .add_conversation_listener(conversation_id.to_string())
            .await?;
        let sub_id = resp.subscription_id;
        let mut guard = self.subscriptions.lock().unwrap();
        guard.insert(conversation_id.to_string(), (sub_id, 1));
        // track as active (best-effort)
        let mut act = self.active_conversations.lock().unwrap();
        act.insert(conversation_id.to_string());
        Ok(())
    }

    /// Ensure listener with resilience: if Codex hasn't finished creating the
    /// conversation yet (addConversationListener returns "conversation not found"),
    /// we will retry for a short window until it becomes available.
    ///
    /// This is important in per-conversation child mode where `newConversation`
    /// and `sessionConfigured` can lag behind the immediate HTTP return; without
    /// retries the listener may never be established and no runtime events will
    /// flow back to the WS hub.
    pub async fn ensure_listener_resilient(&self, conversation_id: &str) -> Result<()> {
        // 并发门闩：同一会话仅允许一个 addConversationListener 在途
        let conv_lock = {
            let mut m = self.listener_guards.lock().unwrap();
            m.entry(conversation_id.to_string())
                .or_insert_with(|| Arc::new(AsyncMutex::new(())))
                .clone()
        };
        let _guard = conv_lock.lock().await;

        // 双检：获取锁后再次快速判断
        {
            let mut guard = self.subscriptions.lock().unwrap();
            if let Some((_sub_id, refcnt)) = guard.get_mut(conversation_id) {
                *refcnt = refcnt.saturating_add(1);
                return Ok(());
            }
        }

        // Retry window is configurable; default to 15s to cover cold start.
        let total_ms: u64 = std::env::var("AILOOM_CODEX_LISTENER_WAIT_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(15_000);
        let step_ms: u64 = std::env::var("AILOOM_CODEX_LISTENER_RETRY_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(300);
        let mut elapsed = 0u64;
        let mut last_err: Option<anyhow::Error> = None;
        loop {
            match self
                .add_conversation_listener(conversation_id.to_string())
                .await
            {
                Ok(resp) => {
                    let sub_id = resp.subscription_id;
                    let mut guard = self.subscriptions.lock().unwrap();
                    guard.insert(conversation_id.to_string(), (sub_id, 1));
                    let mut act = self.active_conversations.lock().unwrap();
                    act.insert(conversation_id.to_string());
                    return Ok(());
                }
                Err(err) => {
                    let msg = err.to_string();
                    // Only retry on specific race: conversation not found.
                    if msg.contains("conversation not found") && elapsed < total_ms {
                        if elapsed == 0 {
                            tracing::info!(
                                target: "codex",
                                conversationId = %conversation_id,
                                waitMs = total_ms,
                                "ensure_listener: conversation not found, retrying until configured",
                            );
                        }
                        last_err = Some(err);
                        tokio::time::sleep(std::time::Duration::from_millis(step_ms)).await;
                        elapsed = elapsed.saturating_add(step_ms);
                        continue;
                    }
                    return Err(err);
                }
            }
        }
        #[allow(unreachable_code)]
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("ensure_listener failed")))
    }

    /// Refresh listener (safe): downgraded to ensure-only to avoid disrupting active streams.
    /// If a listener exists, we only bump refcount; otherwise create a new one. No removal.
    pub async fn refresh_listener(&self, conversation_id: &str) -> Result<()> {
        tracing::info!(target: "codex", conversationId=%conversation_id, "refresh_listener: ensure-only");
        self.ensure_listener(conversation_id).await
    }

    /// Decrement refcount; when reaches zero, remove listener at server.
    pub async fn release_listener(&self, conversation_id: &str) -> Result<()> {
        let maybe = {
            let mut guard = self.subscriptions.lock().unwrap();
            if let Some((sub_id, refcnt)) = guard.get_mut(conversation_id) {
                if *refcnt > 1 {
                    *refcnt -= 1;
                    return Ok(());
                }
                // refcnt == 1: will remove below
                Some(*sub_id)
            } else {
                None
            }
        };
        if let Some(sub_id) = maybe {
            // best-effort RPC
            let _ = self.remove_conversation_listener(sub_id).await;
            let mut guard = self.subscriptions.lock().unwrap();
            guard.remove(conversation_id);
        }
        // also drop from active set
        let mut act = self.active_conversations.lock().unwrap();
        act.remove(conversation_id);
        Ok(())
    }

    #[instrument(level = "info", target = "codex.rpc", skip(self, params), fields(model = %params.model.clone().unwrap_or_default()))]
    pub async fn new_conversation(
        &self,
        params: NewConversationParams,
    ) -> Result<NewConversationResponse> {
        let id = self.rpc().next_request_id();
        let request = JSONRPCRequest {
            id,
            method: "newConversation".into(),
            params: Some(serde_json::to_value(params)?),
        };
        self.rpc().request(request, "newConversation").await
    }

    #[instrument(
        level = "info",
        target = "codex.rpc",
        skip(self, params),
        fields(
            path = %params
                .path
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            conversation_id = %params
                .conversation_id
                .as_ref()
                .map(|id| id.to_string())
                .unwrap_or_default()
        )
    )]
    pub async fn resume_conversation(
        &self,
        params: ResumeConversationParams,
    ) -> Result<ResumeConversationResponse> {
        let id = self.rpc().next_request_id();
        let request = JSONRPCRequest {
            id,
            method: "resumeConversation".into(),
            params: Some(serde_json::to_value(params)?),
        };
        self.rpc().request(request, "resumeConversation").await
    }

    #[instrument(level = "info", target = "codex.rpc", skip(self))]
    pub async fn add_conversation_listener(
        &self,
        conversation_id: String,
    ) -> Result<AddConversationSubscriptionResponse> {
        let start_ts = std::time::Instant::now();
        let id = self.rpc().next_request_id();
        let params = AddConversationListenerParams {
            conversation_id: parse_conversation_id(&conversation_id)?,
            experimental_raw_events: false,
        };
        let request = JSONRPCRequest {
            id,
            method: "addConversationListener".into(),
            params: Some(serde_json::to_value(params)?),
        };
        let resp: AddConversationSubscriptionResponse = self
            .rpc()
            .request(request, "addConversationListener")
            .await?;
        let dur = start_ts.elapsed().as_millis();
        tracing::info!(target:"codex", conversationId=%conversation_id, sub_id=%resp.subscription_id, ms=%dur, "addConversationListener ok");
        Ok(resp)
    }

    #[instrument(level = "info", target = "codex.rpc", skip(self))]
    pub async fn remove_conversation_listener(
        &self,
        subscription_id: uuid::Uuid,
    ) -> Result<RemoveConversationSubscriptionResponse> {
        let id = self.rpc().next_request_id();
        let params = RemoveConversationListenerParams { subscription_id };
        let request = JSONRPCRequest {
            id,
            method: "removeConversationListener".into(),
            params: Some(serde_json::to_value(params)?),
        };
        self.rpc()
            .request(request, "removeConversationListener")
            .await
    }

    #[instrument(level = "info", target = "codex.rpc", skip(self, text), fields(conversation_id = %conversation_id))]
    pub async fn send_user_message(
        &self,
        conversation_id: String,
        text: String,
    ) -> Result<SendUserMessageResponse> {
        let start_ts = std::time::Instant::now();
        let id = self.rpc().next_request_id();
        let params = SendUserMessageParams {
            conversation_id: parse_conversation_id(&conversation_id)?,
            items: vec![InputItem::Text { text }],
        };
        let request = JSONRPCRequest {
            id,
            method: "sendUserMessage".into(),
            params: Some(serde_json::to_value(params)?),
        };
        let resp: SendUserMessageResponse = self.rpc().request(request, "sendUserMessage").await?;
        let dur = start_ts.elapsed().as_millis();
        tracing::info!(target:"codex", conversationId=%conversation_id, ms=%dur, "sendUserMessage ok");
        Ok(resp)
    }

    #[instrument(level = "info", target = "codex.rpc", skip(self), fields(conversation_id = %conversation_id))]
    pub async fn interrupt_conversation(
        &self,
        conversation_id: String,
    ) -> Result<InterruptConversationResponse> {
        let id = self.rpc().next_request_id();
        let params = InterruptConversationParams {
            conversation_id: parse_conversation_id(&conversation_id)?,
        };
        let request = JSONRPCRequest {
            id,
            method: "interruptConversation".into(),
            params: Some(serde_json::to_value(params)?),
        };
        self.rpc().request(request, "interruptConversation").await
    }

    #[instrument(level = "info", target = "codex.rpc", skip(self, params))]
    pub async fn list_conversations(
        &self,
        params: ListConversationsParams,
    ) -> Result<ListConversationsResponse> {
        let id = self.rpc().next_request_id();
        let request = JSONRPCRequest {
            id,
            method: "listConversations".into(),
            params: Some(serde_json::to_value(params)?),
        };
        self.rpc().request(request, "listConversations").await
    }

    #[instrument(level = "info", target = "codex.rpc", skip(self, params))]
    pub async fn list_models(&self, params: ListModelsParams) -> Result<ListModelsResponse> {
        let id = self.rpc().next_request_id();
        let request = JSONRPCRequest {
            id,
            method: "listModels".into(),
            params: Some(serde_json::to_value(params)?),
        };
        self.rpc().request(request, "listModels").await
    }

    #[allow(dead_code)]
    #[instrument(level = "info", target = "codex.rpc", skip(self))]
    pub async fn get_user_saved_config(&self) -> Result<GetUserSavedConfigResponse> {
        let id = self.rpc().next_request_id();
        let request = JSONRPCRequest {
            id,
            method: "getUserSavedConfig".into(),
            params: None,
        };
        self.rpc().request(request, "getUserSavedConfig").await
    }
}

#[async_trait::async_trait]
impl JsonRpcCallbacks for AppServerClient {
    async fn on_server_request(
        &self,
        peer: &JsonRpcPeer,
        _raw: &str,
        request: JSONRPCRequest,
    ) -> Result<()> {
        let method = request.method.clone();
        let server_request = ServerRequest::try_from(request.clone());
        tracing::info!(target: "codex.rpc", server_request = %method, "rpc ⇐ server-request");
        match server_request {
            Ok(ServerRequest::ApplyPatchApproval { request_id, .. }) => {
                let response = typed_response(
                    request_id,
                    ApplyPatchApprovalResponse {
                        decision: ReviewDecision::ApprovedForSession,
                    },
                )?;
                peer.send_response(response).await?;
            }
            Ok(ServerRequest::ExecCommandApproval { request_id, .. }) => {
                let response = typed_response(
                    request_id,
                    ExecCommandApprovalResponse {
                        decision: ReviewDecision::ApprovedForSession,
                    },
                )?;
                peer.send_response(response).await?;
            }
            Err(_) => {
                let response = JSONRPCResponse {
                    id: request.id,
                    result: Value::Null,
                };
                peer.send_response(response).await?;
            }
        }
        Ok(())
    }

    async fn on_notification(
        &self,
        _peer: &JsonRpcPeer,
        _raw: &str,
        notification: JSONRPCNotification,
    ) -> Result<bool> {
        tracing::info!(target:"codex.rpc", method=%notification.method, "rpc ⇐ notification");
        // Lifecycle tracking: add/remove active conversations & auto-release listeners on shutdown
        // We inspect the raw notification before mapping/broadcasting.
        if notification.method == "codex/sessionConfigured" {
            if let Some(params) = notification.params.as_ref() {
                if let Some(cid) = params
                    .as_object()
                    .and_then(|m| m.get("conversationId"))
                    .and_then(|v| v.as_str())
                {
                    let mut act = self.active_conversations.lock().unwrap();
                    act.insert(cid.to_string());
                }
            }
        }
        if notification.method.starts_with("codex/event/") {
            // Expect params like { conversationId, msg: { type: "shutdown_complete", ... }, ... }
            if let Some(params) = notification.params.as_ref() {
                let obj = params.as_object();
                let cid_opt = obj
                    .and_then(|m| m.get("conversationId"))
                    .and_then(|v| v.as_str());
                let msg_type = obj
                    .and_then(|m| m.get("msg"))
                    .and_then(|v| v.as_object())
                    .and_then(|m| m.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                // 在每轮回合开始时，保障监听已就绪（ensure-only，不移除旧监听）。
                // 这能显著降低两会话并发或重连抖动下，Codex 仍向旧通道写入导致“sending into a closed channel”的概率，
                // 同时避免等待 watchdog 介入的空窗期。
                if msg_type == "task_started" {
                    if let Some(cid) = cid_opt {
                        let cid_str = cid.to_string();
                        let this = self.clone();
                        // 异步保障，避免阻塞通知转发路径。
                        tokio::spawn(async move {
                            let _ = this.ensure_listener(&cid_str).await;
                        });
                    }
                }
                if msg_type == "shutdown_complete" {
                    if let Some(cid) = cid_opt {
                        // 为避免在事件仍在路上的窗口误关闭旧通道，这里不再立即 release；
                        // 交由上层 watchdog/空闲回收策略处理。可用环境变量强制恢复旧行为。
                        let allow_release = std::env::var("AILOOM_CODEX_RELEASE_ON_SHUTDOWN")
                            .ok()
                            .map(|v| v == "1")
                            .unwrap_or(false);
                        if allow_release {
                            let _ = self.release_listener(cid).await;
                        } else {
                            tracing::info!(target:"codex", conversationId=%cid, "suppress release_listener on shutdown_complete (ensure-only mode)");
                            // 同时清理强自愈叠加的监听，避免长期泄漏
                            let list_opt = {
                                let mut extras = self.extra_subscriptions.lock().unwrap();
                                extras.remove(cid)
                            };
                            if let Some(list) = list_opt {
                                for sub in list.into_iter() {
                                    let _ = self.remove_conversation_listener(sub).await;
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(hub) = self.hub.lock().unwrap().clone() {
            // 先映射 runtime → chat.*（简化：不做强自愈相关的短窗去重）
            let mapped = map_notification_to_chat_events(&notification);
            if let Some(observer) = self.runtime_observer.lock().unwrap().clone() {
                for event in mapped.iter() {
                    observer.on_runtime_event(&event.method, &event.params);
                }
            }
            for BroadcastEvent {
                method,
                params,
                persistent,
            } in mapped.into_iter()
            {
                if persistent {
                    hub.broadcast(method, params);
                } else {
                    hub.broadcast_ephemeral(method, params);
                }
            }
            let mapped_generic = map_notification(&notification);
            if let Some(observer) = self.runtime_observer.lock().unwrap().clone() {
                for event in mapped_generic.iter() {
                    observer.on_runtime_event(&event.method, &event.params);
                }
            }
            for BroadcastEvent {
                method,
                params,
                persistent,
            } in mapped_generic.into_iter()
            {
                if persistent {
                    hub.broadcast(method, params);
                } else {
                    hub.broadcast_ephemeral(method, params);
                }
            }
        }
        Ok(false)
    }

    async fn on_response(
        &self,
        _peer: &JsonRpcPeer,
        _raw: &str,
        response: &JSONRPCResponse,
    ) -> Result<()> {
        let label = _peer.label_for(&response.id);
        tracing::info!(target:"codex.rpc", id=?response.id, label=?label, "rpc ⇐ response");
        Ok(())
    }

    async fn on_error(&self, _peer: &JsonRpcPeer, _raw: &str, error: &JSONRPCError) -> Result<()> {
        let label = _peer.label_for(&error.id);
        tracing::warn!(target:"codex.rpc", code=%error.error.code, message=%error.error.message, label=?label, "rpc ⇐ error");
        Ok(())
    }

    async fn on_shutdown(&self, _peer: &JsonRpcPeer) -> Result<()> {
        // 保守处理：不再清空本地 active 集合，避免丢失“需要恢复监听的会话”线索；
        // 仅清空本地 subscription id 映射，随后异步重建。
        let need_restore: Vec<String> = {
            let mut guard = self.subscriptions.lock().unwrap();
            let conversations: Vec<String> = guard.keys().cloned().collect();
            guard.clear();
            conversations
        };
        // 清理强自愈叠加的监听 id（不影响上层 active 线索）
        {
            let mut extras = self.extra_subscriptions.lock().unwrap();
            extras.clear();
        }

        if need_restore.is_empty() {
            return Ok(());
        }

        tracing::warn!(target:"codex", count=%need_restore.len(), "codex 通道关闭，安排重建监听");

        // 轻提示（不影响恢复流程）
        if let Some(hub) = self.hub.lock().unwrap().clone() {
            for cid in need_restore.iter() {
                hub.broadcast(
                    "chat.info.background".into(),
                    json!({
                        "conversationId": cid,
                        "message": "Codex 实例已重启，系统正在重新建立实时订阅；若长时间无更新，请刷新页面。"
                    }),
                );
            }
        }

        // Per-conv 模式下不再在 on_shutdown() 尝试“全局恢复监听”，避免在新进程上对历史会话 addListener 造成 not found。
        // 单例模式（legacy）可通过设置 AILOOM_CODEX_MODE=singleton 启用旧逻辑。
        let per_conv = std::env::var("AILOOM_CODEX_MODE")
            .ok()
            .map(|v| v == "per_conv")
            .unwrap_or(true);
        if !per_conv {
            tokio::spawn(async move {
                match super::app_server::get_or_start(None).await {
                    Ok(client) => {
                        if let Some(hub) = client.app().hub.lock().unwrap().clone() {
                            client.register_event_hub(hub);
                        }
                        client.app().restore_active_conversation_listeners().await;
                    }
                    Err(err) => {
                        tracing::warn!(target:"codex", error=%err, "auto-restore listeners failed (will rely on next request/watchdog)");
                    }
                }
            });
        }

        Ok(())
    }
}

fn parse_conversation_id(id: &str) -> Result<ConversationId> {
    ConversationId::from_string(id).map_err(|err| anyhow!("invalid conversation id: {err}"))
}

fn client_notification(notification: ClientNotification) -> Result<JSONRPCNotification> {
    let value = serde_json::to_value(notification)?;
    let method = value
        .get("method")
        .and_then(|m| m.as_str())
        .ok_or_else(|| anyhow!("notification missing method field"))?
        .to_string();
    let params = value.get("params").cloned();
    Ok(JSONRPCNotification { method, params })
}

fn typed_response<T: Serialize>(id: RequestId, payload: T) -> Result<JSONRPCResponse> {
    Ok(JSONRPCResponse {
        id,
        result: serde_json::to_value(payload)?,
    })
}

// —— 短窗弱去重（强自愈双通道时避免双推）——
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or(Duration::from_millis(0))
        .as_millis() as u64
}

// 已移除强自愈相关的短窗去重，保持最简事件路径
