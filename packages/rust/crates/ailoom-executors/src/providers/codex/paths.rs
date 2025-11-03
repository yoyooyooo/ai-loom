use std::path::PathBuf;

/// 返回 Codex 数据目录（包含 history.jsonl、sessions、auth.json 等）。
/// - 当 `CODEX_HOME` 已指向 `.codex` 目录时直接返回。
/// - 当 `CODEX_HOME` 指向上层目录时，自动拼接 `.codex`。
/// - 若未配置，则退回用户主目录下的 `~/.codex`。
pub fn resolve_codex_data_dir() -> Option<PathBuf> {
    let env_path = std::env::var_os("CODEX_HOME").map(PathBuf::from);
    let base = match env_path {
        Some(path) => expand_special_path(path),
        None => dirs::home_dir()?.join(".codex"),
    };

    let normalized = ensure_codex_dir(base);

    Some(normalized)
}

/// 返回 Codex sessions 根目录（`.../.codex/sessions`）。
pub fn resolve_codex_sessions_dir() -> Option<PathBuf> {
    resolve_codex_data_dir().map(|dir| dir.join("sessions"))
}

/// 返回 Codex history.jsonl 文件路径（不保证文件一定存在）。
pub fn resolve_codex_history_log() -> Option<PathBuf> {
    resolve_codex_data_dir().map(|dir| dir.join("history.jsonl"))
}

fn ensure_codex_dir(path: PathBuf) -> PathBuf {
    let is_codex = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case(".codex"))
        .unwrap_or(false);
    if is_codex {
        path
    } else {
        path.join(".codex")
    }
}

fn expand_special_path(path: PathBuf) -> PathBuf {
    let Some(raw) = path.to_str() else {
        return path;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return path;
    }
    if trimmed == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
        return PathBuf::from(trimmed);
    }
    if trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(home) = dirs::home_dir() {
            let rest = trimmed[2..].trim_start_matches(|c| c == '/' || c == '\\');
            if rest.is_empty() {
                return home;
            }
            return home.join(rest);
        }
        return PathBuf::from(trimmed);
    }
    if trimmed.starts_with("~") {
        // e.g. ~username not supported, fall back to raw
        return PathBuf::from(trimmed);
    }
    #[cfg(windows)]
    {
        if let Some(rest) = trimmed.strip_prefix("%USERPROFILE%") {
            if let Ok(user_profile) = std::env::var("USERPROFILE") {
                let mut base = PathBuf::from(user_profile);
                let rest = rest.trim_start_matches(|c| c == '/' || c == '\\');
                if !rest.is_empty() {
                    base = base.join(rest);
                }
                return base;
            }
        }
    }
    PathBuf::from(trimmed)
}

pub fn expand_codex_home(raw: &str) -> PathBuf {
    expand_special_path(PathBuf::from(raw))
}
