use crate::state::AppState;
use ailoom_core::Annotation;
use std::path::{Path as StdPath, PathBuf};

pub fn discover_workspace_root(start: &StdPath) -> Option<PathBuf> {
  let mut cur = start.to_path_buf();
  loop {
    if cur.join(".git").exists() {
      return Some(cur);
    }
    if let Some(parent) = cur.parent() {
      cur = parent.to_path_buf();
    } else {
      return None;
    }
  }
}

pub fn normalize_path_for_key(p: &StdPath) -> String {
  #[cfg(target_os = "macos")]
  {
    if let Some(s) = p.to_str() {
      if s == "/private/var" {
        return "/var".to_string();
      }
      if let Some(rest) = s.strip_prefix("/private/var/") {
        return format!("/var/{rest}");
      }
      if s == "/private/tmp" {
        return "/tmp".to_string();
      }
      if let Some(rest) = s.strip_prefix("/private/tmp/") {
        return format!("/tmp/{rest}");
      }
    }
  }
  p.to_string_lossy().to_string()
}

pub fn to_workspace_relative(state: &AppState, root_rel: &str) -> String {
  let abs = state.root.join(root_rel);
  let abs_can = abs.canonicalize().unwrap_or(abs);
  match abs_can.strip_prefix(&state.workspace_root) {
    Ok(rel) => {
      let s = rel.to_string_lossy().to_string();
      if s.is_empty() { ".".into() } else { s }
    }
    Err(_) => root_rel.to_string(),
  }
}

pub fn from_workspace_to_root(state: &AppState, ws_rel: &str) -> String {
  if let Ok(prefix) = state.root.strip_prefix(&state.workspace_root) {
    let prefix_str = prefix.to_string_lossy();
    if prefix_str.is_empty() {
      return ws_rel.to_string();
    }
    let pre = format!("{}{}", prefix_str, if prefix_str.ends_with('/') { "" } else { "/" });
    if ws_rel == prefix_str {
      return ".".into();
    }
    if let Some(rest) = ws_rel.strip_prefix(&pre) {
      return rest.to_string();
    }
  }
  ws_rel.to_string()
}

pub fn map_and_filter_annotations(state: &AppState, v: Vec<Annotation>) -> Vec<Annotation> {
  let scope_prefix = state.root.strip_prefix(&state.workspace_root).ok();
  let prefix_str = scope_prefix
    .map(|p| p.to_string_lossy().to_string())
    .unwrap_or_default();
  let want_all = prefix_str.is_empty();
  v.into_iter()
    .filter(|a| {
      if want_all {
        true
      } else if a.file_path == prefix_str {
        true
      } else {
        a.file_path.starts_with(&(prefix_str.clone() + "/"))
      }
    })
    .map(|mut a| {
      a.file_path = from_workspace_to_root(state, &a.file_path);
      a
    })
    .collect()
}

