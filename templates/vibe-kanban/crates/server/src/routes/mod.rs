use axum::{
    Router,
    routing::{get, post, put, delete},
};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};
use local_deployment::LocalDeployment;

pub mod api;
pub mod health;

/// Create the main application router
pub fn router(state: LocalDeployment) -> Router
{
    Router::new()
        // Health check endpoint
        .route("/health", get(health::health_check))
        
        // API routes
        .nest("/api", api_router())
        
        // Static file serving - frontend assets
        .nest_service(
            "/assets",
            ServeDir::new("frontend/dist/assets")
                .fallback(ServeFile::new("frontend/dist/index.html")),
        )
        
        // Serve index.html for all other routes (SPA routing)
        .fallback_service(ServeFile::new("frontend/dist/index.html"))
        
        // Add CORS middleware
        .layer(
            CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any),
        )
        
        .with_state(state)
}

/// API routes
fn api_router() -> Router<LocalDeployment> {
    Router::new()
        // Example entity routes - replace with your actual entities
        .route("/entities", get(api::list_entities))
        .route("/entities", post(api::create_entity))
        .route("/entities/{id}", get(api::get_entity))
        .route("/entities/{id}", put(api::update_entity))
        .route("/entities/{id}", delete(api::delete_entity))
}