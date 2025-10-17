use crate::{services::verification::verify_annotations_for_file, state::AppState, web::error};
use ailoom_fs::{read_file_chunk, FsConfig};
use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQuery {
  pub path: String,
  pub start_line: Option<usize>,
  pub max_lines: Option<usize>,
}

pub async fn api_file(Query(q): Query<FileQuery>, fs: FsConfig) -> impl IntoResponse {
  let start = q.start_line.unwrap_or(1);
  let max = q.max_lines.unwrap_or(2000).min(5000);
  match read_file_chunk(&fs, &q.path, start, max) {
    Ok(chunk) => Json(chunk).into_response(),
    Err(e) => {
      let msg = e.to_string();
      if msg == "NON_TEXT" {
        (StatusCode::UNSUPPORTED_MEDIA_TYPE, Json(error("NON_TEXT", "non-text file"))).into_response()
      } else {
        (StatusCode::BAD_REQUEST, Json(error("INVALID_PATH", &msg))).into_response()
      }
    }
  }
}

#[derive(Debug, serde::Deserialize)]
pub struct FileFullQuery { pub path: String }

pub async fn api_file_full(Query(q): Query<FileFullQuery>, fs: FsConfig) -> impl IntoResponse {
  match ailoom_fs::read_file_full(&fs, &q.path) {
    Ok(ff) => Json(serde_json::json!({
      "path": ff.path, "language": ff.language, "size": ff.size, "content": ff.content, "digest": ff.digest
    })).into_response(),
    Err(e) => {
      let msg = e.to_string();
      if msg == "NON_TEXT" {
        (StatusCode::UNSUPPORTED_MEDIA_TYPE, Json(error("NON_TEXT", "non-text file"))).into_response()
      } else if msg == "OVER_LIMIT" {
        (StatusCode::PAYLOAD_TOO_LARGE, Json(error("OVER_LIMIT", "file too large for full read"))).into_response()
      } else {
        (StatusCode::BAD_REQUEST, Json(error("INVALID_PATH", &msg))).into_response()
      }
    }
  }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBody { pub path: String, pub content: String, pub base_digest: Option<String> }

pub async fn api_file_put(
  axum::extract::State(state): axum::extract::State<AppState>,
  Json(body): Json<SaveBody>,
) -> impl IntoResponse {
  match ailoom_fs::write_file(&state.fs, &body.path, &body.content, body.base_digest.as_deref()) {
    Ok(new_digest) => {
      let st = state.clone();
      let path = body.path.clone();
      tokio::spawn(async move {
        let _ = verify_annotations_for_file(&st, &path, Some(40), Some(5 * 1024 * 1024), true).await;
      });
      Json(serde_json::json!({"ok": true, "digest": new_digest})).into_response()
    }
    Err(ailoom_fs::WriteError::Conflict { current_digest }) => (
      StatusCode::CONFLICT,
      Json(serde_json::json!({"error": {"code": "CONFLICT", "currentDigest": current_digest}})),
    ).into_response(),
    Err(ailoom_fs::WriteError::Io(e)) => (
      StatusCode::INTERNAL_SERVER_ERROR,
      Json(error("INTERNAL", &e.to_string())),
    ).into_response(),
  }
}
