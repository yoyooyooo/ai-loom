use axum::{http::StatusCode, response::IntoResponse, Json};
use codex_app_server_protocol::{ListModelsParams, ListModelsResponse};
use codex_protocol::{config_types::SandboxMode, protocol::AskForApproval};
use serde::Serialize;
use serde_json::to_value;
use std::sync::Arc;

use crate::{routes::chat::utils::codex_not_reachable_hint, state::AppState};
use ailoom_executors::providers::codex::current;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatModelSummary {
    id: String,
    model: String,
    display_name: String,
    description: Option<String>,
    is_default: bool,
    default_reasoning_effort: Option<String>,
    supported_reasoning_efforts: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatDefaults {
    model: Option<String>,
    approval_policy: Option<String>,
    sandbox_mode: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatConfigResponse {
    models: Vec<ChatModelSummary>,
    defaults: ChatDefaults,
    #[serde(default)]
    codex_unavailable: bool,
}

pub async fn get_chat_config(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
    let Some(client) = current().await else {
        let defaults = ChatDefaults {
            model: None,
            approval_policy: Some("on-request".into()),
            sandbox_mode: Some("workspace-write".into()),
        };
        let response = ChatConfigResponse {
            models: vec![],
            defaults,
            codex_unavailable: true,
        };
        let hint = codex_not_reachable_hint();
        tracing::info!(target:"codex", "Codex 未初始化，返回兜底配置: {}", hint);
        return (StatusCode::OK, Json(response)).into_response();
    };
    if let Some(hub) = state.ws_hub.clone() {
        client.register_event_hub(Arc::new(hub) as ailoom_executors::SharedEventHub);
    }
    let app = client.app();

    // 可选：是否调用 listModels 填充模型列表（默认关闭，避免在部分版本/未认证态下报错干扰）
    let list_models: bool = std::env::var("AILOOM_CODEX_LIST_MODELS")
        .ok()
        .map(|v| v == "1")
        .unwrap_or(false);
    let models = if list_models {
        match app
            .list_models(ListModelsParams {
                page_size: None,
                cursor: None,
            })
            .await
        {
            Ok(res) => map_models(res),
            Err(err) => {
                tracing::warn!(target:"codex", error=%err, "listModels 调用失败");
                vec![]
            }
        }
    } else {
        vec![]
    };

    let defaults = match app.get_user_saved_config().await {
        Ok(res) => map_defaults(
            res.config.approval_policy,
            res.config.sandbox_mode,
            res.config.model,
        ),
        Err(err) => {
            tracing::warn!(target:"codex", error=%err, "getUserSavedConfig 调用失败");
            ChatDefaults {
                model: None,
                approval_policy: None,
                sandbox_mode: None,
            }
        }
    };

    (
        StatusCode::OK,
        Json(ChatConfigResponse {
            models,
            defaults,
            codex_unavailable: false,
        }),
    )
        .into_response()
}

fn map_models(response: ListModelsResponse) -> Vec<ChatModelSummary> {
    response
        .items
        .into_iter()
        .map(|item| {
            let description = if item.description.trim().is_empty() {
                None
            } else {
                Some(item.description.clone())
            };
            ChatModelSummary {
                id: item.id,
                model: item.model,
                display_name: item.display_name,
                description,
                is_default: item.is_default,
                default_reasoning_effort: Some(item.default_reasoning_effort.to_string()),
                supported_reasoning_efforts: item
                    .supported_reasoning_efforts
                    .into_iter()
                    .map(|effort| effort.reasoning_effort.to_string())
                    .collect(),
            }
        })
        .collect()
}

fn ask_for_approval_to_string(value: Option<AskForApproval>) -> Option<String> {
    value.and_then(|v| to_value(v).ok()?.as_str().map(|s| s.to_string()))
}

fn sandbox_mode_to_string(value: Option<SandboxMode>) -> Option<String> {
    value.and_then(|v| to_value(v).ok()?.as_str().map(|s| s.to_string()))
}

fn map_defaults(
    approval: Option<AskForApproval>,
    sandbox: Option<SandboxMode>,
    model: Option<String>,
) -> ChatDefaults {
    ChatDefaults {
        model,
        approval_policy: ask_for_approval_to_string(approval),
        sandbox_mode: sandbox_mode_to_string(sandbox),
    }
}
