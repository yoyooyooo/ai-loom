use once_cell::sync::Lazy;
use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tokio::task::spawn_blocking;
use uuid::Uuid;

use super::paths::resolve_codex_sessions_dir;

const CACHE_TTL: Duration = Duration::from_secs(5);
const HEADER_SCAN_LIMIT: usize = 32;

#[derive(Clone)]
struct OfflineEntry {
    key: CursorKey,
    conversation_id: String,
    timestamp: String,
    path: PathBuf,
}

#[derive(Clone, Eq, PartialEq)]
struct CursorKey {
    ts: String,
    uuid: Uuid,
}

impl CursorKey {
    fn parse(token: &str) -> Option<Self> {
        let (ts, uuid_str) = token.split_once('|')?;
        let uuid = Uuid::parse_str(uuid_str).ok()?;
        Some(Self {
            ts: ts.to_string(),
            uuid,
        })
    }

    fn from_path(path: &Path) -> Option<Self> {
        let file_name = path.file_name()?.to_string_lossy();
        let core = file_name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
        let (sep_idx, uuid) = core
            .rmatch_indices('-')
            .find_map(|(idx, _)| Uuid::parse_str(&core[idx + 1..]).ok().map(|u| (idx, u)))?;
        let ts = &core[..sep_idx];
        Some(Self {
            ts: ts.to_string(),
            uuid,
        })
    }

    fn token(&self) -> String {
        format!("{}|{}", self.ts, self.uuid)
    }
}

impl Ord for CursorKey {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.ts.cmp(&other.ts) {
            Ordering::Equal => self.uuid.cmp(&other.uuid),
            ord => ord,
        }
    }
}

impl PartialOrd for CursorKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

struct OfflineCache {
    entries: Vec<OfflineEntry>,
    last_refresh: Option<Instant>,
}

impl OfflineCache {
    fn new() -> Self {
        Self {
            entries: Vec::new(),
            last_refresh: None,
        }
    }
}

static OFFLINE_CACHE: Lazy<RwLock<OfflineCache>> = Lazy::new(|| RwLock::new(OfflineCache::new()));

pub struct OfflineConversationPage {
    pub items: Vec<Value>,
    pub next_cursor: Option<String>,
}

pub async fn list_offline_conversations(
    page_size: usize,
    cursor: Option<&str>,
) -> std::io::Result<OfflineConversationPage> {
    ensure_cache().await?;

    let mut cache = OFFLINE_CACHE.write().await;
    cache.entries.retain(|entry| entry.path.exists());
    if cache.entries.is_empty() {
        return Ok(OfflineConversationPage {
            items: Vec::new(),
            next_cursor: None,
        });
    }

    let start_index = cursor
        .and_then(CursorKey::parse)
        .and_then(|key| {
            cache
                .entries
                .iter()
                .position(|entry| entry.key == key)
                .map(|idx| idx + 1)
        })
        .unwrap_or(0);

    let mut items: Vec<Value> = Vec::new();
    for entry in cache.entries.iter().skip(start_index).take(page_size) {
        let mut map = Map::new();
        let path_str = entry.path.to_string_lossy().to_string();
        map.insert(
            "conversation_id".into(),
            Value::String(entry.conversation_id.clone()),
        );
        map.insert("path".into(), Value::String(path_str.clone()));
        map.insert("rollout_path".into(), Value::String(path_str));
        map.insert("timestamp".into(), Value::String(entry.timestamp.clone()));
        map.insert("created_at".into(), Value::String(entry.timestamp.clone()));
        items.push(Value::Object(map));
    }

    let has_more = start_index + items.len() < cache.entries.len();
    let next_cursor = if has_more {
        cache
            .entries
            .get(start_index + items.len() - 1)
            .map(|entry| entry.key.token())
    } else {
        None
    };

    Ok(OfflineConversationPage { items, next_cursor })
}

pub async fn invalidate_offline_entry(path: impl AsRef<Path>) {
    let target = path.as_ref();
    let mut cache = OFFLINE_CACHE.write().await;
    cache.entries.retain(|entry| entry.path.as_path() != target);
}

async fn ensure_cache() -> std::io::Result<()> {
    let need_refresh = {
        let cache = OFFLINE_CACHE.read().await;
        match cache.last_refresh {
            None => true,
            Some(last) => last.elapsed() >= CACHE_TTL,
        }
    };

    if !need_refresh {
        return Ok(());
    }

    let Some(root) = resolve_codex_sessions_dir() else {
        let mut cache = OFFLINE_CACHE.write().await;
        cache.entries.clear();
        cache.last_refresh = Some(Instant::now());
        return Ok(());
    };

    let entries = spawn_blocking(move || scan_offline_conversations(&root))
        .await
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err.to_string()))?;

    match entries {
        Ok(entries) => {
            let mut cache = OFFLINE_CACHE.write().await;
            cache.entries = entries;
            cache.last_refresh = Some(Instant::now());
        }
        Err(err) => {
            let mut cache = OFFLINE_CACHE.write().await;
            cache.entries.clear();
            cache.last_refresh = Some(Instant::now());
            return Err(err);
        }
    }

    Ok(())
}

fn scan_offline_conversations(root: &Path) -> std::io::Result<Vec<OfflineEntry>> {
    let mut files: Vec<PathBuf> = Vec::new();
    collect_rollout_files(root, &mut files)?;

    let mut entries: Vec<OfflineEntry> = Vec::new();
    for path in files {
        let Some(cursor_key) = CursorKey::from_path(&path) else {
            continue;
        };
        if let Some((conversation_id, timestamp)) = parse_rollout_header(&path) {
            entries.push(OfflineEntry {
                key: cursor_key,
                conversation_id,
                timestamp,
                path,
            });
        }
    }

    entries.sort_by(|a, b| b.key.cmp(&a.key));
    Ok(entries)
}

fn collect_rollout_files(root: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if !root.is_dir() {
        return Ok(());
    }
    let mut queue: VecDeque<PathBuf> = VecDeque::new();
    queue.push_back(root.to_path_buf());

    while let Some(dir) = queue.pop_front() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.is_dir() {
                queue.push_back(path);
            } else if path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("jsonl"))
                .unwrap_or(false)
            {
                out.push(path);
            }
        }
    }
    Ok(())
}

fn parse_rollout_header(path: &Path) -> Option<(String, String)> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().flatten().take(HEADER_SCAN_LIMIT) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
            let payload = value.get("payload")?;
            let id = payload.get("id")?.as_str()?;
            let timestamp = payload
                .get("timestamp")
                .and_then(|t| t.as_str())
                .or_else(|| value.get("timestamp").and_then(|t| t.as_str()))
                .unwrap_or_default();
            return Some((id.to_string(), timestamp.to_string()));
        }
    }
    None
}
