use std::{net::SocketAddr, path::PathBuf};

use ailoom_core::{Annotation, CreateAnnotation, DirEntry, FileChunk, UpdateAnnotation};
use ailoom_fs::{list_dir, read_file_chunk, FsConfig};
use ailoom_stitch as stitch;
use ailoom_store::Store;
use axum::extract::{Path, State};
use axum::{extract::Query, http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use clap::Parser;
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
    trace::TraceLayer,
};
use tracing_subscriber::{fmt, EnvFilter};

#[derive(Debug, Parser)]
struct Args {
    /// Project root
    #[arg(long, default_value = ".")]
    root: PathBuf,
    /// Static web dist directory (will be served at "/")
    #[arg(long, default_value = "packages/web/dist")]
    web_dist: PathBuf,
    /// Disable serving static files (API only; for dev with Vite)
    #[arg(long, default_value_t = false)]
    no_static: bool,
    /// SQLite db path (default: ~/ailoom/ailoom.db)
    #[arg(long)]
    db_path: Option<PathBuf>,
    /// Port to bind (default: random free port)
    #[arg(long)]
    port: Option<u16>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    fmt().with_env_filter(filter).init();

    let args = Args::parse();
    // 版本与构建信息（由 build.rs 注入；main=0.0.0 时可通过 tag/sha 辅助定位）
    let app_version = env!("APP_VERSION");
    let app_git_tag = env!("APP_GIT_TAG");
    let app_git_sha = env!("APP_GIT_SHA");
    let app_build_ts = env!("APP_BUILD_TS");
    tracing::info!("ailoom-server version={} tag={} sha={} built={}", app_version, app_git_tag, app_git_sha, app_build_ts);
    let root = args.root.canonicalize()?;
    let fs_cfg = FsConfig::new(root.clone());

    // Prepare DB path
    let db_path = if let Some(p) = args.db_path {
        p
    } else {
        let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home dir"))?;
        home.join("ailoom").join("ailoom.db")
    };
    if let Some(dir) = db_path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let store = match Store::connect_path(&db_path).await {
        Ok(s) => s,
        Err(e) => {
            // fallback to project root .ailoom/ailoom.db
            let fallback = root.join(".ailoom").join("ailoom.db");
            if let Some(dir) = fallback.parent() {
                std::fs::create_dir_all(dir).ok();
            }
            tracing::warn!(
                "failed to open db at {}, fallback to {}: {}",
                db_path.display(),
                fallback.display(),
                e
            );
            Store::connect_path(&fallback).await?
        }
    };

    let fs_cfg_tree = fs_cfg.clone();
    let fs_cfg_file = fs_cfg.clone();
    let fs_cfg_full = fs_cfg.clone();
    let api = Router::new()
        .route("/api/tree", get(move |q| api_tree(q, fs_cfg_tree.clone())))
        .route("/api/file", get(move |q| api_file(q, fs_cfg_file.clone())))
        .route(
            "/api/file/full",
            get(move |q| api_file_full(q, fs_cfg_full.clone())),
        )
        .route("/api/file", axum::routing::put(api_file_put))
        .route(
            "/api/annotations",
            get(list_annotations).post(create_annotation),
        )
        .route(
            "/api/annotations/:id",
            axum::routing::put(update_annotation).delete(delete_annotation),
        )
        .route(
            "/api/annotations/import",
            axum::routing::post(import_annotations),
        )
        .route("/api/annotations/export", get(export_annotations))
        .route("/api/stitch", axum::routing::post(stitch_endpoint))
        .with_state(AppState {
            fs: fs_cfg.clone(),
            store: store,
        })
        // Enable permissive CORS for API routes to support Vite dev server during local development.
        // Static files are served under `/` without CORS needs.
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );

    // static files (optional)
    let app = if args.no_static {
        Router::new().merge(api).layer(TraceLayer::new_for_http())
    } else {
        Router::new()
            .nest_service("/", ServeDir::new(args.web_dist))
            .merge(api)
            .layer(TraceLayer::new_for_http())
    };

    let bind_addr: SocketAddr = match args.port {
        Some(p) => SocketAddr::from(([127, 0, 0, 1], p)),
        None => SocketAddr::from(([127, 0, 0, 1], 0)),
    };
    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    let addr = listener.local_addr()?;
    tracing::info!("listening on http://{}", addr);
    println!("AILOOM_PORT={}", addr.port());
    axum::serve(listener, app).await?;
    Ok(())
}

// error handler inlined above

#[derive(Debug, serde::Deserialize)]
struct TreeQuery {
    dir: Option<String>,
}

async fn api_tree(Query(q): Query<TreeQuery>, fs: FsConfig) -> impl IntoResponse {
    let dir = q.dir.unwrap_or_else(|| ".".into());
    match list_dir(&fs, &dir) {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(error("INVALID_PATH", &e.to_string())),
        )
            .into_response(),
    }
}

#[derive(Debug, serde::Deserialize)]
struct FileQuery {
    path: String,
    startLine: Option<usize>,
    maxLines: Option<usize>,
}

async fn api_file(Query(q): Query<FileQuery>, fs: FsConfig) -> impl IntoResponse {
    let start = q.startLine.unwrap_or(1);
    let max = q.maxLines.unwrap_or(2000).min(5000);
    match read_file_chunk(&fs, &q.path, start, max) {
        Ok(chunk) => Json(chunk).into_response(),
        Err(e) => {
            let msg = e.to_string();
            if msg == "NON_TEXT" {
                (
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    Json(error("NON_TEXT", "non-text file")),
                )
                    .into_response()
            } else {
                (StatusCode::BAD_REQUEST, Json(error("INVALID_PATH", &msg))).into_response()
            }
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct FileFullQuery {
    path: String,
}

async fn api_file_full(Query(q): Query<FileFullQuery>, fs: FsConfig) -> impl IntoResponse {
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
        },
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveBody {
    path: String,
    content: String,
    baseDigest: Option<String>,
}

async fn api_file_put(
    State(state): State<AppState>,
    Json(body): Json<SaveBody>,
) -> impl IntoResponse {
    match ailoom_fs::write_file(
        &state.fs,
        &body.path,
        &body.content,
        body.baseDigest.as_deref(),
    ) {
        Ok(new_digest) => {
            Json(serde_json::json!({"ok": true, "digest": new_digest})).into_response()
        }
        Err(ailoom_fs::WriteError::Conflict { current_digest }) => (
            StatusCode::CONFLICT,
            Json(
                serde_json::json!({"error": {"code": "CONFLICT", "currentDigest": current_digest}}),
            ),
        )
            .into_response(),
        Err(ailoom_fs::WriteError::Io(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(error("INTERNAL", &e.to_string())),
        )
            .into_response(),
    }
}

fn error(code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({"error": {"code": code, "message": message}})
}

#[derive(Clone)]
struct AppState {
    fs: FsConfig,
    store: Store,
}

// --- annotations handlers ---

async fn list_annotations(State(state): State<AppState>) -> impl IntoResponse {
    match state.store.list_annotations().await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(error("INTERNAL", &e.to_string())),
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody(CreateAnnotation);

async fn create_annotation(
    State(state): State<AppState>,
    Json(body): Json<CreateAnnotation>,
) -> impl IntoResponse {
    let id = nanoid::nanoid!();
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "".into());
    let ann = Annotation {
        id,
        file_path: body.file_path,
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
        Ok(_) => Json(ann).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(error("INTERNAL", &e.to_string())),
        )
            .into_response(),
    }
}

async fn update_annotation(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateAnnotation>,
) -> impl IntoResponse {
    match state.store.get_annotation(&id).await {
        Ok(Some(mut ex)) => {
            if let Some(v) = body.file_path {
                ex.file_path = v;
            }
            if let Some(v) = body.start_line {
                ex.start_line = v;
            }
            if let Some(v) = body.end_line {
                ex.end_line = v;
            }
            if let Some(v) = body.start_column {
                ex.start_column = Some(v);
            }
            if let Some(v) = body.end_column {
                ex.end_column = Some(v);
            }
            if let Some(v) = body.selected_text {
                ex.selected_text = v;
            }
            if let Some(v) = body.comment {
                ex.comment = v;
            }
            if let Some(v) = body.pre_context_hash {
                ex.pre_context_hash = Some(v);
            }
            if let Some(v) = body.post_context_hash {
                ex.post_context_hash = Some(v);
            }
            if let Some(v) = body.file_digest {
                ex.file_digest = Some(v);
            }
            if let Some(v) = body.tags {
                ex.tags = Some(v);
            }
            if let Some(v) = body.priority {
                ex.priority = Some(v);
            }
            ex.updated_at = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| ex.updated_at);
            match state.store.update_annotation(&ex).await {
                Ok(_) => Json(ex).into_response(),
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(error("INTERNAL", &e.to_string())),
                )
                    .into_response(),
            }
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(error("NOT_FOUND", "annotation not found")),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(error("INTERNAL", &e.to_string())),
        )
            .into_response(),
    }
}

async fn delete_annotation(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.delete_annotation(&id).await {
        Ok(_) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(error("INTERNAL", &e.to_string())),
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", untagged)]
enum ImportPayload {
    Bundle {
        schema_version: String,
        annotations: Vec<Annotation>,
    },
    Direct {
        annotations: Vec<Annotation>,
    },
}

async fn import_annotations(
    State(state): State<AppState>,
    Json(payload): Json<ImportPayload>,
) -> impl IntoResponse {
    let anns = match payload {
        ImportPayload::Bundle { annotations, .. } => annotations,
        ImportPayload::Direct { annotations } => annotations,
    };
    match state.store.import_annotations(&anns).await {
        Ok((added, updated, skipped)) => {
            Json(serde_json::json!({"added": added, "updated": updated, "skipped": skipped}))
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(error("INTERNAL", &e.to_string())),
        )
            .into_response(),
    }
}

async fn export_annotations(State(state): State<AppState>) -> impl IntoResponse {
    match state.store.export_all().await {
        Ok(anns) => {
            let exported_at = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| "".into());
            Json(serde_json::json!({"schemaVersion": "1", "annotations": anns, "exportedAt": exported_at})).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(error("INTERNAL", &e.to_string())),
        )
            .into_response(),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StitchQuery {
    template_id: Option<String>,
    max_chars: Option<usize>,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StitchBody {
    annotation_ids: Option<Vec<String>>,
}

async fn stitch_endpoint(
    State(state): State<AppState>,
    Query(q): Query<StitchQuery>,
    Json(body): Json<StitchBody>,
) -> impl IntoResponse {
    let ids = body.annotation_ids.unwrap_or_default();
    let anns = match state.store.list_annotations_by_ids(&ids).await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(error("INTERNAL", &e.to_string())),
            )
                .into_response()
        }
    };
    let tpl = stitch::TemplateId::parse(q.template_id.as_deref().unwrap_or("concise"));
    let max_chars = q.max_chars.unwrap_or(4000).max(200).min(200_000);
    let r = stitch::generate_prompt(tpl, max_chars, anns);
    Json(serde_json::json!({
        "prompt": r.prompt,
        "stats": {"total": r.stats.total, "used": r.stats.used, "truncated": r.stats.truncated, "chars": r.stats.chars}
    })).into_response()
}
