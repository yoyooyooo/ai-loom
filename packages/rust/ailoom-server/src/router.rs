use crate::ws::ws_upgrade_handler;
use crate::{
    routes::{
        annotations::{
            create_annotation, delete_annotation, export_annotations, import_annotations,
            list_annotations, update_annotation,
        },
        files::{api_file, api_file_full, api_file_put},
        stitch::stitch_endpoint,
        tree::api_tree,
        verify::verify_annotations_endpoint,
    },
    state::AppState,
};
use axum::{routing::get, Router};
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
    trace::TraceLayer,
};

pub fn build_router(state: AppState, web_dist: std::path::PathBuf, no_static: bool) -> Router {
    let fs_cfg_tree = state.fs.clone();
    let fs_cfg_file = state.fs.clone();
    let fs_cfg_full = state.fs.clone();
    let api = Router::new()
        .route("/api/tree", get(move |q| api_tree(q, fs_cfg_tree.clone())))
        .route("/api/file", get(move |q| api_file(q, fs_cfg_file.clone())))
        .route(
            "/api/file/full",
            get(move |q| api_file_full(q, fs_cfg_full.clone())),
        )
        .route(
            "/api/codex/default-credentials",
            get(crate::routes::codex::verify_default_codex_files),
        )
        .route(
            "/api/settings/runtime",
            get(crate::routes::settings::get_runtime_settings)
                .put(crate::routes::settings::update_runtime_settings),
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
        // chat api (skeleton - Phase 2)
        .route(
            "/api/chat/conversations",
            get(crate::routes::chat::list_conversations)
                .post(crate::routes::chat::new_conversation)
                .delete(crate::routes::chat::delete_conversation),
        )
        .route(
            "/api/chat/conversations/resume",
            axum::routing::post(crate::routes::chat::resume_conversation),
        )
        .route(
            "/api/chat/conversations/:conversationId/messages",
            axum::routing::post(crate::routes::chat::send_message),
        )
        .route(
            "/api/chat/conversations/:conversationId/turns",
            axum::routing::post(crate::routes::chat::send_turn),
        )
        .route(
            "/api/chat/conversations/:conversationId/interrupt",
            axum::routing::post(crate::routes::chat::interrupt_conversation),
        )
        .route(
            "/api/chat/conversations/:conversationId",
            get(crate::routes::chat::get_conversation),
        )
        .route(
            "/api/chat/runtime",
            get(crate::routes::chat::get_runtime_snapshot),
        )
        .route(
            "/api/chat/conversations/:conversationId/warm",
            axum::routing::post(crate::routes::chat::warm_runtime),
        )
        .route(
            "/api/chat/conversations/:conversationId/process",
            axum::routing::delete(crate::routes::chat::delete_runtime_process),
        )
        .route(
            "/api/chat/vibe-link",
            axum::routing::post(crate::routes::chat::check_vibe_link),
        )
        .route(
            "/api/chat/config",
            get(crate::routes::chat::get_chat_config),
        )
        .route(
            "/api/chat/output",
            get(crate::routes::chat::get_turn_output),
        )
        .route(
            "/api/annotations/verify",
            axum::routing::post(verify_annotations_endpoint),
        )
        .route("/debug/codex", get(crate::routes::debug::codex_debug))
        .route("/debug/ws", get(crate::routes::debug::ws_debug))
        .route("/ws", get(ws_upgrade_handler))
        .with_state(state)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );

    if no_static {
        Router::new().merge(api).layer(TraceLayer::new_for_http())
    } else {
        Router::new()
            .nest_service("/", ServeDir::new(web_dist))
            .merge(api)
            .layer(TraceLayer::new_for_http())
    }
}
