use axum::{http::StatusCode, response::IntoResponse, Json};
use codex_app_server_protocol::{ListModelsParams, ListModelsResponse};
use codex_protocol::{config_types::SandboxMode, protocol::AskForApproval};
use serde::Serialize;
use serde_json::to_value;

use crate::{
    routes::chat::utils::codex_not_reachable_hint, services::codex::app_server::get_or_start,
    state::AppState,
};

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
}

pub async fn get_chat_config(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
    let client = match get_or_start(Some(state.workspace_root.clone())).await {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Codex 未就绪：{}。{}", e, codex_not_reachable_hint());
            return (StatusCode::BAD_GATEWAY, msg).into_response();
        }
    };
    if let Some(hub) = state.ws_hub.clone() {
        client.register_ws_hub(hub);
    }
    let app = client.app();

    let models = match app
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
        Json(ChatConfigResponse { models, defaults }),
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
