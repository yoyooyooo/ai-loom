use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

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
use serde_json::Value;
use tracing::instrument;

use crate::ws::hub::Hub;

use super::bridge::{map_notification, map_notification_to_chat_events, BroadcastEvent};
use super::transport::{JsonRpcCallbacks, JsonRpcPeer};

#[derive(Clone)]
pub struct AppServerClient {
    rpc: OnceLock<JsonRpcPeer>,
    hub: Arc<Mutex<Option<Hub>>>,
    // conversation_id -> (subscription_id, refcount)
    subscriptions: Arc<Mutex<HashMap<String, (uuid::Uuid, usize)>>>,
    // best-effort active set; used for lifecycle hints (release on shutdown)
    active_conversations: Arc<Mutex<HashSet<String>>>,
}

impl AppServerClient {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            rpc: OnceLock::new(),
            hub: Arc::new(Mutex::new(None)),
            subscriptions: Arc::new(Mutex::new(HashMap::new())),
            active_conversations: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    pub fn connect(&self, peer: JsonRpcPeer) {
        let _ = self.rpc.set(peer);
    }

    fn rpc(&self) -> &JsonRpcPeer {
        self.rpc.get().expect("Codex RPC peer not attached")
    }

    pub fn register_ws_hub(&self, hub: Hub) {
        *self.hub.lock().unwrap() = Some(hub);
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

    #[instrument(level = "info", target = "codex.rpc", skip(self, params), fields(path = %params.path.display()))]
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
        self.rpc().request(request, "addConversationListener").await
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
        self.rpc().request(request, "sendUserMessage").await
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
                if msg_type == "shutdown_complete" {
                    if let Some(cid) = cid_opt {
                        // best-effort: release listener when session shuts down
                        let _ = self.release_listener(cid).await;
                    }
                }
            }
        }
        if let Some(hub) = self.hub.lock().unwrap().clone() {
            for BroadcastEvent {
                method,
                params,
                persistent,
            } in map_notification_to_chat_events(&notification)
            {
                if persistent {
                    hub.broadcast(method, params);
                } else {
                    hub.broadcast_ephemeral(method, params);
                }
            }
            for BroadcastEvent {
                method,
                params,
                persistent,
            } in map_notification(&notification)
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
        tracing::info!(target:"codex.rpc", id=?response.id, "rpc ⇐ response");
        Ok(())
    }

    async fn on_error(&self, _peer: &JsonRpcPeer, _raw: &str, error: &JSONRPCError) -> Result<()> {
        tracing::warn!(target:"codex.rpc", code=%error.error.code, message=%error.error.message, "rpc ⇐ error");
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
