use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};

use crate::state::AppState;
use ailoom_executors::providers::codex::expand_codex_home;

pub const DEFAULT_CODEX_HOME: &str = "~/.codex";
const RUNTIME_NAMESPACE: &str = "runtime";
const CODEX_HOME_KEY: &str = "codexHome";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettingsResponse {
    pub codex_home: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRuntimeSettingsRequest {
    pub codex_home: Option<String>,
}

pub async fn get_runtime_settings(State(state): State<AppState>) -> impl IntoResponse {
    match state
        .store
        .get_setting(RUNTIME_NAMESPACE, CODEX_HOME_KEY)
        .await
    {
        Ok(value_opt) => {
            let stored = value_opt
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| DEFAULT_CODEX_HOME.to_string());
            let sanitized = sanitize_codex_home(&stored);
            Json(RuntimeSettingsResponse {
                codex_home: sanitized,
            })
            .into_response()
        }
        Err(err) => {
            let msg = format!("加载设置失败: {err}");
            (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response()
        }
    }
}

pub async fn update_runtime_settings(
    State(state): State<AppState>,
    Json(payload): Json<UpdateRuntimeSettingsRequest>,
) -> impl IntoResponse {
    let incoming = payload.codex_home.unwrap_or_default();
    let sanitized = sanitize_codex_home(&incoming);
    let value = serde_json::Value::String(sanitized.clone());

    if let Err(err) = state
        .store
        .set_setting(RUNTIME_NAMESPACE, CODEX_HOME_KEY, &value, Some("api"), None)
        .await
    {
        let msg = format!("保存设置失败: {err}");
        return (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response();
    }

    apply_codex_home_env(&sanitized);

    Json(RuntimeSettingsResponse {
        codex_home: sanitized,
    })
    .into_response()
}

pub fn sanitize_codex_home(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        DEFAULT_CODEX_HOME.to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn apply_codex_home_env(value: &str) {
    let expanded = expand_codex_home(value);
    let path_str = expanded.to_string_lossy().to_string();
    if let Some(parent) = expanded.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::create_dir_all(&expanded);
    std::env::set_var("CODEX_HOME", path_str);
}
