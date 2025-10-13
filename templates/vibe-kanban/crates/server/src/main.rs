use anyhow::Result;
use local_deployment::LocalDeployment;
use server::routes;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info,vibe-starter=debug".into());
    
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();

    tracing::info!("🚀 Starting vibe-starter server...");

    // Initialize deployment service
    let deployment = LocalDeployment::new().await?;
    
    // Create router
    let app = routes::router(deployment);
    
    // Get port from environment or auto-assign
    let port = std::env::var("BACKEND_PORT")
        .unwrap_or_else(|_| "0".to_string())
        .parse::<u16>()
        .unwrap_or(0);
    
    let addr = format!("127.0.0.1:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let actual_port = listener.local_addr()?.port();
    
    tracing::info!("🌐 Server running on http://127.0.0.1:{}", actual_port);
    
    // Auto-open browser in production (not in debug mode)
    if !cfg!(debug_assertions) {
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
            if let Err(e) = open::that(format!("http://127.0.0.1:{}", actual_port)) {
                tracing::warn!("Failed to open browser: {}", e);
            }
        });
    }
    
    // Start server
    axum::serve(listener, app).await?;
    
    Ok(())
}
