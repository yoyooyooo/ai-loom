use crate::{
  paths::{from_workspace_to_root, map_and_filter_annotations, to_workspace_relative},
  state::AppState,
  web::error,
};
use ailoom_core::{Annotation, CreateAnnotation, UpdateAnnotation};
use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};

pub async fn list_annotations(axum::extract::State(state): axum::extract::State<AppState>) -> impl IntoResponse {
  match state.store.list_annotations().await {
    Ok(v) => Json(map_and_filter_annotations(&state, v)).into_response(),
    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(error("INTERNAL", &e.to_string()))).into_response(),
  }
}

pub async fn create_annotation(
  axum::extract::State(state): axum::extract::State<AppState>,
  Json(body): Json<CreateAnnotation>,
) -> impl IntoResponse {
  let id = uuid::Uuid::new_v4().to_string();
  let now = time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_else(|_| "".into());
  let ws_rel_path = to_workspace_relative(&state, &body.file_path);
  let ann = Annotation {
    id,
    file_path: ws_rel_path.clone(),
    start_line: body.start_line,
    end_line: body.end_line,
    start_column: body.start_column,
    end_column: body.end_column,
    selected_text: body.selected_text,
    comment: body.comment,
    pre_context_hash: body.pre_context_hash,
    post_context_hash: body.post_context_hash,
    file_digest: body.file_digest,
    tags: body.tags,
    priority: Some(body.priority.unwrap_or_else(|| "P1".into())),
    created_at: now.clone(),
    updated_at: now,
  };
  match state.store.insert_annotation(&ann).await {
    Ok(_) => {
      let mut out = ann.clone();
      out.file_path = from_workspace_to_root(&state, &ws_rel_path);
      Json(out).into_response()
    }
    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(error("INTERNAL", &e.to_string()))).into_response(),
  }
}

pub async fn update_annotation(
  axum::extract::State(state): axum::extract::State<AppState>,
  Path(id): Path<String>,
  Json(body): Json<UpdateAnnotation>,
) -> impl IntoResponse {
  match state.store.get_annotation(&id).await {
    Ok(Some(mut ex)) => {
      if let Some(v) = body.file_path { ex.file_path = to_workspace_relative(&state, &v); }
      if let Some(v) = body.start_line { ex.start_line = v; }
      if let Some(v) = body.end_line { ex.end_line = v; }
      if let Some(v) = body.start_column { ex.start_column = Some(v); }
      if let Some(v) = body.end_column { ex.end_column = Some(v); }
      if let Some(v) = body.selected_text { ex.selected_text = v; }
      if let Some(v) = body.comment { ex.comment = v; }
      if let Some(v) = body.pre_context_hash { ex.pre_context_hash = Some(v); }
      if let Some(v) = body.post_context_hash { ex.post_context_hash = Some(v); }
      if let Some(v) = body.file_digest { ex.file_digest = Some(v); }
      if let Some(v) = body.tags { ex.tags = Some(v); }
      if let Some(v) = body.priority { ex.priority = Some(v); }
      ex.updated_at = time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_else(|_| ex.updated_at);
      match state.store.update_annotation(&ex).await {
        Ok(_) => { let mut out = ex.clone(); out.file_path = from_workspace_to_root(&state, &out.file_path); Json(out).into_response() }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(error("INTERNAL", &e.to_string()))).into_response(),
      }
    }
    Ok(None) => (StatusCode::NOT_FOUND, Json(error("NOT_FOUND", "annotation not found"))).into_response(),
    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(error("INTERNAL", &e.to_string()))).into_response(),
  }
}

pub async fn delete_annotation(axum::extract::State(state): axum::extract::State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
  match state.store.delete_annotation(&id).await {
    Ok(_) => Json(serde_json::json!({"ok": true})).into_response(),
    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(error("INTERNAL", &e.to_string()))).into_response(),
  }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum ImportPayload {
  Bundle { schema_version: String, annotations: Vec<Annotation> },
  Direct { annotations: Vec<Annotation> },
}

pub async fn import_annotations(
  axum::extract::State(state): axum::extract::State<AppState>,
  Json(payload): Json<ImportPayload>,
) -> impl IntoResponse {
  let anns_ws: Vec<Annotation> = match payload {
    ImportPayload::Bundle { schema_version: _sv, annotations } => annotations,
    ImportPayload::Direct { annotations } => annotations
  }
    .into_iter().map(|mut a| { a.file_path = to_workspace_relative(&state, &a.file_path); a }).collect();
  match state.store.import_annotations(&anns_ws).await {
    Ok((added, updated, skipped)) => Json(serde_json::json!({"added": added, "updated": updated, "skipped": skipped})).into_response(),
    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(error("INTERNAL", &e.to_string()))).into_response(),
  }
}

pub async fn export_annotations(axum::extract::State(state): axum::extract::State<AppState>) -> impl IntoResponse {
  match state.store.export_all().await {
    Ok(anns_raw) => {
      let exported_at = time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_else(|_| "".into());
      let anns = map_and_filter_annotations(&state, anns_raw);
      Json(serde_json::json!({"schemaVersion": "1", "annotations": anns, "exportedAt": exported_at})).into_response()
    }
    Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(error("INTERNAL", &e.to_string()))).into_response(),
  }
}
