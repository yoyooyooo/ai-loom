use crate::web::error;
use ailoom_fs::{list_dir, FsConfig};
use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};

#[derive(Debug, serde::Deserialize)]
pub struct TreeQuery {
  pub dir: Option<String>,
}

pub async fn api_tree(Query(q): Query<TreeQuery>, fs: FsConfig) -> impl IntoResponse {
  let dir = q.dir.unwrap_or_else(|| ".".into());
  match list_dir(&fs, &dir) {
    Ok(entries) => Json(entries).into_response(),
    Err(e) => (StatusCode::BAD_REQUEST, Json(error("INVALID_PATH", &e.to_string()))).into_response(),
  }
}

