use std::{net::SocketAddr, path::PathBuf};

use clap::Parser;
use tracing_subscriber::{fmt, EnvFilter};

mod state;
mod web;
mod paths;
mod services;
mod routes;
mod router;

use ailoom_fs::FsConfig;
use ailoom_store::Store;
use paths::{discover_workspace_root, normalize_path_for_key};
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
  tracing::info!("ailoom-server version={} tag={} sha={} built={}", app_version, app_git_tag, app_git_sha, app_build_ts);

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
  if let Some(dir) = db_path.parent() { std::fs::create_dir_all(dir).ok(); }
  let store = match Store::connect_path(&db_path, &workspace_key).await {
    Ok(s) => s,
    Err(e) => {
      // fallback to project root .ailoom/ailoom.db
      let fallback = root.join(".ailoom").join("ailoom.db");
      if let Some(dir) = fallback.parent() { std::fs::create_dir_all(dir).ok(); }
      tracing::warn!("failed to open db at {}, fallback to {}: {}", db_path.display(), fallback.display(), e);
      Store::connect_path(&fallback, &workspace_key).await?
    }
  };

  let app_state = AppState { fs: fs_cfg.clone(), store, root: root.clone(), workspace_root: workspace_root.clone() };
  let app = router::build_router(app_state, args.web_dist.clone(), args.no_static);

  let bind_addr: SocketAddr = match args.port { Some(p) => SocketAddr::from(([127, 0, 0, 1], p)), None => SocketAddr::from(([127, 0, 0, 1], 0)), };
  let listener = tokio::net::TcpListener::bind(bind_addr).await?;
  let addr = listener.local_addr()?;
  tracing::info!("listening on http://{}", addr);
  println!("AILOOM_PORT={}", addr.port());
  axum::serve(listener, app).await?;
  Ok(())
}

