use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyDefaultCodexResponse {
    default_dir: Option<String>,
    auth_exists: bool,
    config_exists: bool,
}

fn codex_default_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".codex"))
}

pub async fn verify_default_codex_files() -> impl IntoResponse {
    let (default_dir_str, auth_exists, config_exists) = match codex_default_dir() {
        Some(dir) => {
            let auth = dir.join("auth.json");
            let config = dir.join("config.toml");
            (
                Some(dir.to_string_lossy().to_string()),
                auth.exists(),
                config.exists(),
            )
        }
        None => (None, false, false),
    };

    let body = VerifyDefaultCodexResponse {
        default_dir: default_dir_str,
        auth_exists,
        config_exists,
    };

    (StatusCode::OK, Json(body)).into_response()
}
