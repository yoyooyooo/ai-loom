use axum::{extract::Query, http::StatusCode, response::IntoResponse};

use crate::{routes::chat::resume::service::resolve_blob_base_dir, state::AppState};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputQuery {
    pub conversation_id: String,
    pub blob_id: String,
}

pub async fn get_turn_output(
    Query(q): Query<OutputQuery>,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
    use tokio::fs;
    let cid_safe = q.conversation_id.replace('/', "_").replace(':', "_");
    let primary = resolve_blob_base_dir(&state).join(&cid_safe);
    let fallback = state
        .workspace_root
        .join(".ailoom")
        .join("resume-blobs")
        .join(&cid_safe);
    let mut candidates = vec![primary.clone()];
    if fallback != primary {
        candidates.push(fallback);
    }
    for base in candidates {
        let path = base.join(format!("{}.txt", q.blob_id));
        if let Ok(content) = fs::read_to_string(&path).await {
            return (StatusCode::OK, content).into_response();
        }
    }
    (
        StatusCode::NOT_FOUND,
        format!("blob {} not found for conversation", q.blob_id),
    )
        .into_response()
}
