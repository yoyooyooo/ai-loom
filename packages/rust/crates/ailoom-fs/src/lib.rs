use ailoom_core::{DirEntry, EntryType, FileChunk};
use ignore::WalkBuilder;
use std::{fs, io::{BufRead, BufReader, Read}, path::{Path, PathBuf}};
use sha2::{Sha256, Digest};

const SOFT_SIZE_BYTES: u64 = 2 * 1024 * 1024; // 2MB
const HARD_SIZE_BYTES: u64 = 5 * 1024 * 1024; // 5MB

#[derive(Clone)]
pub struct FsConfig {
    pub root: PathBuf,
}

impl FsConfig {
    pub fn new(root: PathBuf) -> Self { Self { root } }
}

fn ensure_within_root(root: &Path, abs: &Path) -> bool {
    match abs.canonicalize() {
        Ok(c) => c.starts_with(root),
        Err(_) => false,
    }
}

pub fn list_dir(cfg: &FsConfig, rel_dir: &str) -> std::io::Result<Vec<DirEntry>> {
    let dir_abs = cfg.root.join(rel_dir);
    let dir_abs = dir_abs.canonicalize()?;
    if !ensure_within_root(&cfg.root, &dir_abs) { return Err(std::io::Error::new(std::io::ErrorKind::Other, "INVALID_PATH")); }

    // Use ignore WalkBuilder to honor .gitignore and allow .ailoomignore
    let mut entries: Vec<DirEntry> = Vec::new();
    let mut builder = WalkBuilder::new(&dir_abs);
    builder.max_depth(Some(1));
    builder.hidden(false);
    builder.follow_links(false);
    // merge ignore patterns: .gitignore honored by default; add .ailoomignore if present
    let ailoom_ignore = dir_abs.join(".ailoomignore");
    if ailoom_ignore.exists() { builder.add_ignore(ailoom_ignore); }

    for result in builder.build() {
        let dent = match result { Ok(d) => d, Err(_) => continue };
        if dent.path() == dir_abs { continue; }
        let meta = match dent.metadata() { Ok(m) => m, Err(_) => continue };
        // basic hard excludes
        if dent.file_name() == ".git" || dent.file_name() == "node_modules" { continue; }
        let r#type = if meta.is_dir() { EntryType::Dir } else { EntryType::File };

        let name = dent.file_name().to_string_lossy().to_string();
        // path relative to root
        let rel_path = pathdiff::diff_paths(dent.path(), &cfg.root)
            .unwrap_or_else(|| PathBuf::from(name.clone()));
        let rel_str = rel_path.to_string_lossy().to_string();
        let size = if meta.is_file() { Some(meta.len()) } else { None };
        entries.push(DirEntry { name, path: rel_str, r#type, size });
    }
    // sort: dirs first then files by name
    entries.sort_by(|a,b| match (&a.r#type, &b.r#type) {
        (EntryType::Dir, EntryType::File) => std::cmp::Ordering::Less,
        (EntryType::File, EntryType::Dir) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

pub fn read_file_chunk(cfg: &FsConfig, rel_path: &str, start_line: usize, max_lines: usize) -> std::io::Result<FileChunk> {
    let abs = cfg.root.join(rel_path);
    let abs = abs.canonicalize()?;
    if !ensure_within_root(&cfg.root, &abs) { return Err(std::io::Error::new(std::io::ErrorKind::Other, "INVALID_PATH")); }
    let meta = fs::metadata(&abs)?;
    if !meta.is_file() { return Err(std::io::Error::new(std::io::ErrorKind::Other, "NOT_FILE")); }

    // 非文本/二进制快速探测（前 64KB）
    if is_non_text(&abs, 64 * 1024)? { return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "NON_TEXT")); }

    let size = meta.len();
    let hard = size > HARD_SIZE_BYTES;
    let soft = size > SOFT_SIZE_BYTES;

    let file = fs::File::open(&abs)?;
    let reader = BufReader::new(file);
    let mut total_lines = 0usize;
    let mut content_lines: Vec<String> = Vec::new();
    let end_target = start_line.saturating_add(max_lines).saturating_sub(1);
    for (i, line_res) in reader.lines().enumerate() {
        let ln = i + 1;
        if let Ok(line) = line_res {
            if ln >= start_line && ln <= end_target { content_lines.push(line); }
            total_lines = ln;
        }
    }

    let content = content_lines.join("\n");
    let end_line = std::cmp::min(end_target, total_lines);
    let truncated = hard || (soft && (end_line < total_lines));

    let rel_str = pathdiff::diff_paths(&abs, &cfg.root)
        .unwrap_or_else(|| PathBuf::from(rel_path))
        .to_string_lossy()
        .to_string();
    let lang = ailoom_core::guess_language_by_ext(&rel_str);

    Ok(FileChunk {
        path: rel_str,
        language: lang,
        size,
        total_lines,
        start_line,
        end_line,
        content,
        truncated,
    })
}

#[derive(Debug, Clone)]
pub struct FullFile {
    pub path: String,
    pub language: String,
    pub size: u64,
    pub content: String,
    pub digest: String,
}

pub fn read_file_full(cfg: &FsConfig, rel_path: &str) -> std::io::Result<FullFile> {
    let abs = cfg.root.join(rel_path);
    let abs = abs.canonicalize()?;
    if !ensure_within_root(&cfg.root, &abs) { return Err(std::io::Error::new(std::io::ErrorKind::Other, "INVALID_PATH")); }
    let meta = fs::metadata(&abs)?;
    if !meta.is_file() { return Err(std::io::Error::new(std::io::ErrorKind::Other, "NOT_FILE")); }
    let size = meta.len();
    // 先整体读取字节，再判断是否为文本（UTF-8 且不含 NUL）
    let bytes = fs::read(&abs)?;
    if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "NON_TEXT"));
    }
    let content = String::from_utf8(bytes).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "NON_TEXT"))?;
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hex::encode(hasher.finalize());
    let rel_str = pathdiff::diff_paths(&abs, &cfg.root)
        .unwrap_or_else(|| PathBuf::from(rel_path))
        .to_string_lossy().to_string();
    let language = ailoom_core::guess_language_by_ext(&rel_str);
    Ok(FullFile { path: rel_str, language, size, content, digest })
}

#[derive(Debug)]
pub enum WriteError { Conflict { current_digest: String }, Io(std::io::Error) }
impl From<std::io::Error> for WriteError { fn from(e: std::io::Error) -> Self { WriteError::Io(e) } }

pub fn write_file(cfg: &FsConfig, rel_path: &str, new_content: &str, base_digest: Option<&str>) -> Result<String, WriteError> {
    let abs = cfg.root.join(rel_path);
    let abs = abs.canonicalize().map_err(WriteError::Io)?;
    if !ensure_within_root(&cfg.root, &abs) { return Err(WriteError::Io(std::io::Error::new(std::io::ErrorKind::Other, "INVALID_PATH"))); }
    if fs::metadata(&abs).map_err(WriteError::Io)?.is_dir() { return Err(WriteError::Io(std::io::Error::new(std::io::ErrorKind::Other, "IS_DIR"))); }

    // digest check
    let current = fs::read(&abs).map_err(WriteError::Io)?;
    let mut hasher = Sha256::new(); hasher.update(&current); let current_digest = hex::encode(hasher.finalize());
    if let Some(b) = base_digest { if b != current_digest { return Err(WriteError::Conflict { current_digest }); } }

    // atomic write: write temp then rename
    let dir = abs.parent().ok_or_else(|| WriteError::Io(std::io::Error::new(std::io::ErrorKind::Other, "NO_PARENT")))?;
    let tmp = dir.join(format!(".ailoom.tmp.{}", std::process::id()));
    fs::write(&tmp, new_content).map_err(WriteError::Io)?;
    fs::rename(&tmp, &abs).map_err(WriteError::Io)?;

    // new digest
    let mut hasher2 = Sha256::new(); hasher2.update(new_content.as_bytes()); let new_digest = hex::encode(hasher2.finalize());
    Ok(new_digest)
}

// --- helpers ---
fn is_non_text(path: &Path, sample: usize) -> std::io::Result<bool> {
    let mut f = fs::File::open(path)?;
    let mut buf = vec![0u8; sample];
    let n = f.read(&mut buf)?;
    let slice = &buf[..n];
    if slice.contains(&0) { return Ok(true); }
    Ok(std::str::from_utf8(slice).is_err())
}
