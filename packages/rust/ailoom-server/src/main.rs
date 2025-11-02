use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use clap::Parser;
use tracing_subscriber::{fmt, EnvFilter};

mod paths;
mod router;
mod routes;
mod services;
mod state;
mod web;
mod ws;

use ailoom_executors::providers::codex::CodexProvider;
use ailoom_fs::FsConfig;
use ailoom_store::Store;
use paths::{discover_workspace_root, normalize_path_for_key};
use services::executors::registry::RuntimeRegistry;
use state::AppState;

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
    tracing::info!(
        "ailoom-server version={} tag={} sha={} built={}",
        app_version,
        app_git_tag,
        app_git_sha,
        app_build_ts
    );

    let root = args.root.canonicalize()?;
    // Discover workspace root (git repo root if found by walking up to first `.git` dir)
    let workspace_root = discover_workspace_root(&root).unwrap_or_else(|| root.clone());
    let workspace_key = normalize_path_for_key(&workspace_root);
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
    let store = match Store::connect_path(&db_path, &workspace_key).await {
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
            Store::connect_path(&fallback, &workspace_key).await?
        }
    };

    // Init WS hub (Phase 1: enabled by default)
    let ring_cap = std::env::var("AILOOM_WS_RING_CAP")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(4096);
    let hub = ws::hub::Hub::new(ring_cap);
    let runtime_registry = RuntimeRegistry::new();
    let hub_adapter = Some(Arc::new(hub.clone()) as ailoom_executors::SharedEventHub);
    runtime_registry
        .register_provider(CodexProvider::new(workspace_root.clone(), hub_adapter))
        .await;

    let app_state = AppState {
        fs: fs_cfg.clone(),
        store,
        root: root.clone(),
        workspace_root: workspace_root.clone(),
        ws_hub: Some(hub.clone()),
        runtime_registry: runtime_registry.clone(),
    };
    // Phase 2: optional FS watcher (env: AILOOM_FSWATCH_ENABLED=1)
    let _watcher = ws::watch::spawn_watcher(app_state.clone());
    // Periodic stats broadcast (debug/observability)
    {
        let hub_clone = hub.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let snap = hub_clone.stats_snapshot();
                let ts = time::OffsetDateTime::now_utc()
                    .format(&time::format_description::well_known::Rfc3339)
                    .unwrap_or_else(|_| "".into());
                if let Ok(mut val) = serde_json::to_value(&snap) {
                    if let Some(obj) = val.as_object_mut() {
                        obj.insert("ts".into(), serde_json::json!(ts));
                    }
                    // stats 属于瞬时观测，不入 ring、不携带 eventId，避免污染 resume 语义
                    hub_clone.broadcast_ephemeral("session.stats".into(), val);
                }
            }
        });
    }
    let app = router::build_router(app_state.clone(), args.web_dist.clone(), args.no_static);

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
