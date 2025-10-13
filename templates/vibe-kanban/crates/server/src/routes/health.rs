use axum::{http::StatusCode, response::Json};
use serde_json::{json, Value};

/// Health check endpoint
pub async fn health_check() -> Result<Json<Value>, StatusCode> {
    Ok(Json(json!({
        "status": "healthy",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "service": "vibe-starter"
    })))
}
