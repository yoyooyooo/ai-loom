use crate::{paths::map_and_filter_annotations, state::AppState, web::error};
use ailoom_core::Annotation;
use ailoom_stitch as stitch;
use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StitchQuery { pub template_id: Option<String>, pub max_chars: Option<usize> }
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StitchBody { pub annotation_ids: Option<Vec<String>> }

pub async fn stitch_endpoint(
  axum::extract::State(state): axum::extract::State<AppState>,
  Query(q): Query<StitchQuery>,
  Json(body): Json<StitchBody>,
) -> impl IntoResponse {
  let ids = body.annotation_ids.unwrap_or_default();
  let anns_raw = match state.store.list_annotations_by_ids(&ids).await { Ok(v) => v, Err(e) => { return (StatusCode::INTERNAL_SERVER_ERROR, Json(error("INTERNAL", &e.to_string()))).into_response() } };
  let anns: Vec<Annotation> = map_and_filter_annotations(&state, anns_raw);
  let tpl = stitch::TemplateId::parse(q.template_id.as_deref().unwrap_or("concise"));
  let max_chars = q.max_chars.unwrap_or(4000).max(200).min(200_000);
  let r = stitch::generate_prompt(tpl, max_chars, anns);
  Json(serde_json::json!({"prompt": r.prompt, "stats": {"total": r.stats.total, "used": r.stats.used, "truncated": r.stats.truncated, "chars": r.stats.chars} })).into_response()
}

