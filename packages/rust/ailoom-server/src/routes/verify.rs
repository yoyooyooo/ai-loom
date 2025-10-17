use crate::{services::verification::{verify_annotations_for_file, VerifyResultOut}, state::AppState, web::error};
use axum::{http::StatusCode, response::IntoResponse, Json};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyBody {
  pub file_path: Option<String>,
  pub ids: Option<Vec<String>>, // 预留
  pub window: Option<usize>,
  pub full_limit_bytes: Option<usize>,
  pub remove_broken: Option<bool>,
}

pub async fn verify_annotations_endpoint(
  axum::extract::State(state): axum::extract::State<AppState>,
  Json(body): Json<VerifyBody>,
) -> impl IntoResponse {
  // 读取 ids 以避免 dead_code 告警（预留字段，暂不实现筛选）
  let _ = body.ids.as_ref().map(|v| v.len());
  let file = match body.file_path.as_deref() {
    Some(p) => p.to_string(),
    None => { return (StatusCode::BAD_REQUEST, Json(error("INVALID", "filePath is required"))).into_response(); }
  };
  let window = body.window.unwrap_or(40).max(1).min(2000);
  let full_limit = body.full_limit_bytes.unwrap_or(5 * 1024 * 1024);
  let remove_broken = body.remove_broken.unwrap_or(true);
  match verify_annotations_for_file(&state, &file, Some(window), Some(full_limit), remove_broken).await {
    Ok(v) => Json::<VerifyResultOut>(v).into_response(),
    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(error("INTERNAL", &e.to_string()))).into_response(),
  }
}
