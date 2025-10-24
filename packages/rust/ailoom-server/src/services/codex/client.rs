use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{anyhow, Result};
use codex_app_server_protocol::{
    AddConversationListenerParams, AddConversationSubscriptionResponse, ApplyPatchApprovalResponse,
    ClientInfo, ClientNotification, GetUserSavedConfigResponse, InitializeParams,
    InitializeResponse, InterruptConversationParams, InterruptConversationResponse, JSONRPCError,
    JSONRPCNotification, JSONRPCRequest, JSONRPCResponse, ListConversationsParams,
    ListConversationsResponse, ListModelsParams, ListModelsResponse, NewConversationParams,
    NewConversationResponse, RequestId, ResumeConversationParams, ResumeConversationResponse,
    SendUserMessageParams, SendUserMessageResponse, ServerRequest,
};
use codex_app_server_protocol::{ExecCommandApprovalResponse, InputItem};
use codex_protocol::protocol::ReviewDecision;
use codex_protocol::ConversationId;
use serde::Serialize;
use serde_json::Value;
use tracing::instrument;

use crate::ws::hub::Hub;

use super::bridge::{map_notification, BroadcastEvent};
use super::transport::{JsonRpcCallbacks, JsonRpcPeer};

#[derive(Clone)]
pub struct AppServerClient {
    rpc: OnceLock<JsonRpcPeer>,
    hub: Arc<Mutex<Option<Hub>>>,
}

impl AppServerClient {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            rpc: OnceLock::new(),
            hub: Arc::new(Mutex::new(None)),
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
        if let Some(hub) = self.hub.lock().unwrap().clone() {
            for BroadcastEvent { method, params } in map_notification(&notification) {
                hub.broadcast(method, params);
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
