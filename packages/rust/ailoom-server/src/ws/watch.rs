use std::{
    collections::HashSet,
    path::PathBuf,
    time::{Duration, Instant},
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::state::AppState;
use ignore::gitignore::GitignoreBuilder;

#[derive(Clone, Debug)]
struct Cfg {
    enabled: bool,
    batch_ms: u64,
    max_window_ms: u64,
    max_impacted_paths: usize,
    ignore_vcs: bool,
    ignore_ailoom: bool,
}

fn read_cfg() -> Cfg {
    let enabled = std::env::var("AILOOM_FSWATCH_ENABLED").unwrap_or_else(|_| "0".into()) == "1";
    let batch_ms = std::env::var("AILOOM_FSWATCH_BATCH_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(300);
    let max_window_ms = std::env::var("AILOOM_FSWATCH_MAX_WINDOW_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(1000);
    let max_impacted_paths = std::env::var("AILOOM_FSWATCH_MAX_IMPACTED")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(200);
    let ignore_vcs =
        std::env::var("AILOOM_FSWATCH_IGNORE_VCS").unwrap_or_else(|_| "1".into()) == "1";
    let ignore_ailoom =
        std::env::var("AILOOM_FSWATCH_IGNORE_AILOOM").unwrap_or_else(|_| "1".into()) == "1";
    Cfg {
        enabled,
        batch_ms,
        max_window_ms,
        max_impacted_paths,
        ignore_vcs,
        ignore_ailoom,
    }
}

pub fn spawn_watcher(state: AppState) -> Option<tokio::task::JoinHandle<()>> {
    let cfg = read_cfg();
    if !cfg.enabled {
        return None;
    }
    let root = state.root.clone();
    let hub = match state.ws_hub.clone() {
        Some(h) => h,
        None => return None,
    };
    tracing::info!(target: "fswatch", "starting watcher on {}", root.display());

    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    let mut watcher = match RecommendedWatcher::new(tx, notify::Config::default()) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!(target: "fswatch", "failed to init watcher: {}", e);
            return None;
        }
    };
    if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
        tracing::warn!(target: "fswatch", "failed to watch {}: {}", root.display(), e);
        return None;
    }

    // Move watcher into a new thread to keep it alive; forward events into tokio task
    std::mem::forget(watcher);

    // Build ignore filter
    let filter = build_ignore_filter(&root, &cfg);

    let handle = tokio::spawn(async move {
        let mut pending: Vec<Event> = Vec::new();
        let mut win_start: Option<Instant> = None;
        loop {
            // blocking recv with small timeout to allow batching
            let got = rx.recv_timeout(Duration::from_millis(50));
            match got {
                Ok(Ok(ev)) => {
                    pending.push(ev);
                    if win_start.is_none() {
                        win_start = Some(Instant::now());
                    }
                }
                Ok(Err(_e)) => { /* ignore errors */ }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => { /* fallthrough to flush check */
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    break;
                }
            }
            // flush condition
            if !pending.is_empty() {
                let elapsed = win_start
                    .map(|s| s.elapsed().as_millis() as u64)
                    .unwrap_or(0);
                if elapsed >= cfg.batch_ms || elapsed >= cfg.max_window_ms {
                    let batch = std::mem::take(&mut pending);
                    win_start = None;
                    process_batch(&hub, &root, &cfg, filter.as_ref(), batch);
                }
            }
        }
    });
    Some(handle)
}

fn to_root_rel(root: &PathBuf, p: &PathBuf) -> Option<String> {
    match p.canonicalize() {
        Ok(abs) => {
            if let Ok(rel) = abs.strip_prefix(root) {
                let s = rel.to_string_lossy().replace('\\', "/");
                Some(if s.is_empty() { ".".into() } else { s })
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

fn process_batch(
    hub: &crate::ws::hub::Hub,
    root: &PathBuf,
    cfg: &Cfg,
    filter: Option<&IgnoreFilter>,
    batch: Vec<Event>,
) {
    let mut created: HashSet<String> = HashSet::new();
    let mut modified: HashSet<String> = HashSet::new();
    let mut deleted: HashSet<String> = HashSet::new();
    let mut moved: Vec<(String, String)> = Vec::new();

    for ev in batch.into_iter() {
        // collect paths
        let paths: Vec<String> = ev
            .paths
            .iter()
            .filter_map(|p| to_root_rel(root, p))
            .filter(|p| !is_ignored(filter, p))
            .collect();
        if paths.is_empty() {
            continue;
        }
        match ev.kind {
            EventKind::Create(_) => {
                for p in paths {
                    created.insert(p);
                }
            }
            EventKind::Modify(modk) => {
                use notify::event::ModifyKind;
                match modk {
                    ModifyKind::Name(nm) => {
                        use notify::event::RenameMode;
                        match nm {
                            RenameMode::From => { /* wait for To; not enough info */ }
                            RenameMode::To => { /* handled in both when paths len=2 below */ }
                            RenameMode::Both => {
                                if ev.paths.len() >= 2 {
                                    let from = to_root_rel(root, &ev.paths[0]).unwrap_or_default();
                                    let to = to_root_rel(root, &ev.paths[1]).unwrap_or_default();
                                    if !from.is_empty() && !to.is_empty() {
                                        moved.push((from, to));
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {
                        for p in paths {
                            modified.insert(p);
                        }
                    }
                }
            }
            EventKind::Remove(_) => {
                for p in paths {
                    deleted.insert(p);
                }
            }
            _ => {}
        }
    }

    // apply precedence: deleted > created > modified
    for p in deleted.iter() {
        created.remove(p);
        modified.remove(p);
    }
    for p in created.iter() {
        modified.remove(p);
    }

    // impacted paths for tree summary
    let mut impacted: HashSet<String> = HashSet::new();
    for p in created.iter() {
        impacted.insert(p.clone());
    }
    for p in modified.iter() {
        impacted.insert(p.clone());
    }
    for p in deleted.iter() {
        impacted.insert(p.clone());
    }
    for (from, to) in moved.iter() {
        impacted.insert(from.clone());
        impacted.insert(to.clone());
    }

    let mut impacted_list: Vec<String> = impacted.into_iter().collect();
    impacted_list.sort();
    let truncated = impacted_list.len() > cfg.max_impacted_paths;
    if truncated {
        impacted_list.truncate(cfg.max_impacted_paths);
    }

    // 观测日志（仅摘要），帮助排障：确认 watcher 是否工作以及批次规模
    let sample = impacted_list.get(0).cloned().unwrap_or_default();
    tracing::info!(target: "fswatch",
    created = %created.len(), modified = %modified.len(), deleted = %deleted.len(), moved = %moved.len(),
    impacted = %impacted_list.len(), truncated = %truncated, sample = %sample,
    "batch");

    // broadcast file.changed for each (no digest) and collect stats
    for p in created.iter() {
        hub.broadcast(
            "file.changed".into(),
            serde_json::json!({"path": p, "kind":"created"}),
        );
        hub.inc_file_changed();
    }
    for p in modified.iter() {
        hub.broadcast(
            "file.changed".into(),
            serde_json::json!({"path": p, "kind":"modified"}),
        );
        hub.inc_file_changed();
    }
    for p in deleted.iter() {
        hub.broadcast(
            "file.changed".into(),
            serde_json::json!({"path": p, "kind":"deleted"}),
        );
        hub.inc_file_changed();
    }
    for (from, to) in moved.iter().cloned() {
        hub.broadcast(
            "file.changed".into(),
            serde_json::json!({"path": to, "kind":"moved", "fromPath": from}),
        );
        hub.inc_file_changed();
    }

    // broadcast tree.changed summary
    let summary = serde_json::json!({
      "created": created.len(),
      "modified": modified.len(),
      "deleted": deleted.len(),
      "moved": moved.len(),
      "truncated": truncated,
    });
    hub.broadcast(
        "tree.changed".into(),
        serde_json::json!({"impactedPaths": impacted_list.clone(), "summary": summary }),
    );
    hub.report_tree_changed(impacted_list.len(), moved.len(), truncated);

    // 调试/兜底：可选地在每个批次结束后广播一次 session.resync，强制所有客户端做粗粒度刷新。
    // 仅在 AILOOM_FSWATCH_FORCE_RESYNC=1 时启用，避免影响正常增量路径。
    if std::env::var("AILOOM_FSWATCH_FORCE_RESYNC").unwrap_or_else(|_| "0".into()) == "1" {
        hub.broadcast_ephemeral(
            "session.resync".into(),
            serde_json::json!({"reason":"fswatch_force"}),
        );
        tracing::info!(target:"fswatch", "force session.resync broadcast");
    }
}

// --- ignore helpers ---
struct IgnoreFilter {
    ig: ignore::gitignore::Gitignore,
}

fn build_ignore_filter(root: &PathBuf, cfg: &Cfg) -> Option<IgnoreFilter> {
    let mut b = GitignoreBuilder::new(root);
    let mut has_any = false;
    if cfg.ignore_vcs {
        let gi = root.join(".gitignore");
        if gi.exists() {
            b.add(gi);
            has_any = true;
        }
    }
    if cfg.ignore_ailoom {
        let ai = root.join(".ailoomignore");
        if ai.exists() {
            b.add(ai);
            has_any = true;
        }
    }
    if !has_any {
        return None;
    }
    match b.build() {
        Ok(ig) => Some(IgnoreFilter { ig }),
        Err(e) => {
            tracing::warn!(target: "fswatch", "ignore build failed: {}", e);
            None
        }
    }
}

fn is_ignored(filter: Option<&IgnoreFilter>, rel_path: &str) -> bool {
    if let Some(f) = filter {
        let m = f.ig.matched(rel_path, false);
        if m.is_ignore() {
            return true;
        }
    }
    // hard excludes
    rel_path.starts_with(".git/")
        || rel_path == ".git"
        || rel_path.starts_with("node_modules/")
        || rel_path == "node_modules"
}
