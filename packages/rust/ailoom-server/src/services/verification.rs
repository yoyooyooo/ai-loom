use crate::{
  paths::to_workspace_relative,
  state::AppState,
};
use ailoom_core::Annotation;
use anyhow::Result;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResultOut {
  pub checked: usize,
  pub updated: usize,
  pub deleted: usize,
  pub skipped: usize,
  pub updated_ids: Vec<String>,
  pub deleted_ids: Vec<String>,
  pub skipped_ids: Vec<String>,
}

pub async fn verify_annotations_for_file(
  state: &AppState,
  root_rel_path: &str,
  window: Option<usize>,
  full_limit_bytes: Option<usize>,
  remove_broken: bool,
) -> Result<VerifyResultOut> {
  let ws_rel = to_workspace_relative(state, root_rel_path);
  let anns_all = state.store.list_annotations().await?;
  let mut target: Vec<Annotation> = anns_all
    .into_iter()
    .filter(|a| a.file_path == ws_rel)
    .collect();
  if target.is_empty() {
    return Ok(VerifyResultOut { checked: 0, updated: 0, deleted: 0, skipped: 0, updated_ids: vec![], deleted_ids: vec![], skipped_ids: vec![] });
  }

  let win = window.unwrap_or(40);
  let full_limit = full_limit_bytes.unwrap_or(5 * 1024 * 1024);

  // 尝试读取全文（≤阈值）
  let mut full_text: Option<String> = None;
  let mut full_digest: Option<String> = None;
  match ailoom_fs::read_file_full(&state.fs, root_rel_path) {
    Ok(ff) => {
      if (ff.size as usize) <= full_limit {
        full_digest = Some(ff.digest.clone());
        full_text = Some(ff.content);
      }
    }
    Err(e) => {
      let msg = e.to_string();
      if msg == "OVER_LIMIT" || msg == "NON_TEXT" || msg == "INVALID_PATH" || msg == "NOT_FILE" {
        // 忽略
      } else {
        tracing::warn!("verify: read_file_full failed for {}: {}", root_rel_path, msg);
      }
    }
  }

  fn find_all_positions(text: &str, needle: &str) -> Vec<(usize, usize, usize, usize)> {
    let mut res = Vec::new();
    if needle.is_empty() || text.is_empty() { return res; }
    let mut start_idx = 0usize;
    while let Some(pos) = text[start_idx..].find(needle) {
      let abs = start_idx + pos;
      let before = &text[..abs];
      let s_line = 1 + bytecount::count(before.as_bytes(), b'\n');
      let last_nl = before.rfind('\n');
      let s_col = match last_nl {
        Some(i) => text[i+1..abs].chars().count() + 1,
        None => before.chars().count() + 1,
      };
      let end_abs = abs + needle.len();
      let before_end = &text[..end_abs];
      let e_line = 1 + bytecount::count(before_end.as_bytes(), b'\n');
      let last_nl2 = before_end.rfind('\n');
      let e_col = match last_nl2 {
        Some(i) => text[i+1..end_abs].chars().count() + 1,
        None => before_end.chars().count() + 1,
      };
      res.push((s_line, e_line, s_col, e_col));
      start_idx = end_abs;
    }
    res
  }

  fn slice_by_char_cols(line: &str, start_col_1b: usize, end_col_1b: usize) -> String {
    if line.is_empty() { return String::new(); }
    let start_char = start_col_1b.saturating_sub(1);
    let end_char = end_col_1b.saturating_sub(1);
    let mut start_byte = None;
    let mut end_byte = None;
    for (ci, (bi, _ch)) in line.char_indices().enumerate() {
      if start_byte.is_none() && ci == start_char { start_byte = Some(bi); }
      if ci == end_char { end_byte = Some(bi); break; }
    }
    let sb = start_byte.unwrap_or_else(|| line.len());
    let eb = end_byte.unwrap_or_else(|| line.len());
    if sb > eb { return String::new(); }
    line.get(sb..eb).unwrap_or("") .to_string()
  }

  let mut checked = 0usize;
  let mut updated = 0usize;
  let mut deleted = 0usize;
  let mut skipped = 0usize;
  let mut updated_ids = Vec::new();
  let mut deleted_ids = Vec::new();
  let mut skipped_ids = Vec::new();

  for mut ann in target.drain(..) {
    checked += 1;
    if ann.selected_text.trim().is_empty() {
      if remove_broken {
        if let Err(e) = state.store.delete_annotation(&ann.id).await {
          tracing::warn!("verify: delete(empty-selected) failed for {}: {}", ann.id, e);
        } else { deleted += 1; deleted_ids.push(ann.id.clone()); }
      } else { skipped += 1; skipped_ids.push(ann.id.clone()); }
      continue;
    }

    // 快速检查：窗口内按字符切片比较
    let mut cur_text_same = false;
    let win_start = if ann.start_line > 1 { (ann.start_line as usize).saturating_sub(1) } else { 1 };
    let need = (ann.end_line - ann.start_line + 1).max(1) as usize;
    match ailoom_fs::read_file_chunk(&state.fs, root_rel_path, win_start, need) {
      Ok(ch) => {
        let lines: Vec<&str> = ch.content.split('\n').collect();
        let s_rel = (ann.start_line as usize).saturating_sub(ch.start_line).saturating_add(1).max(1);
        let e_rel = (ann.end_line as usize).saturating_sub(ch.start_line).saturating_add(1).max(1).min(lines.len());
        if s_rel <= e_rel && s_rel <= lines.len() {
          let s_col = ann.start_column.unwrap_or(1).max(1) as usize;
          let e_col = ann.end_column.unwrap_or(usize::MAX as i64) as usize;
          let cur = if s_rel == e_rel {
            let l = lines[s_rel - 1];
            slice_by_char_cols(l, s_col, e_col)
          } else {
            let mut buf = String::new();
            let first = lines[s_rel - 1];
            buf.push_str(&slice_by_char_cols(first, s_col, usize::MAX));
            for i in (s_rel)..(e_rel - 1) { buf.push_str("\n"); buf.push_str(lines[i]); }
            let last = lines[e_rel - 1];
            buf.push_str("\n");
            buf.push_str(&slice_by_char_cols(last, 1, e_col));
            buf
          };
          cur_text_same = cur == ann.selected_text;
        }
      }
      Err(_) => {}
    }
    if cur_text_same { continue; }

    // 窗口搜索（±win）
    let mut new_pos: Option<(usize, usize, usize, usize)> = None;
    let win_start2 = (ann.start_line as usize).saturating_sub(win);
    let win_end2 = (ann.end_line as usize + win).max(win_start2 + 1);
    let max_lines = win_end2.saturating_sub(win_start2) + 1;
    if let Ok(ch) = ailoom_fs::read_file_chunk(&state.fs, root_rel_path, win_start2.max(1), max_lines) {
      let content = ch.content.clone();
      let occs = find_all_positions(&content, &ann.selected_text);
      if !occs.is_empty() {
        let anchor = ann.start_line.max(1) as usize;
        let mut best = occs[0];
        let mut best_dist = best.0.abs_diff(anchor);
        for o in occs.into_iter().skip(1) { let d = o.0.abs_diff(anchor); if d < best_dist { best = o; best_dist = d; } }
        let s_abs = ch.start_line + best.0 - 1;
        let e_abs = ch.start_line + best.1 - 1;
        new_pos = Some((s_abs, e_abs, best.2, best.3));
      }
    }

    // 边界锚定（多行选区）
    if new_pos.is_none() {
      if ann.selected_text.contains('\n') {
        if let Ok(ch2) = ailoom_fs::read_file_chunk(&state.fs, root_rel_path, win_start2.max(1), max_lines) {
          let lines_vec: Vec<&str> = ch2.content.split('\n').collect();
          let head = ann.selected_text.split('\n').next().unwrap_or("").trim();
          let tail = ann.selected_text.rsplit('\n').next().unwrap_or("").trim();
          if !head.is_empty() && !tail.is_empty() {
            let mut best_s: Option<(usize, usize, usize)> = None;
            let mut best_s_dist = usize::MAX;
            for (i, ln) in lines_vec.iter().enumerate() {
              if let Some(byte_pos) = ln.find(head) {
                let abs_line = ch2.start_line + i;
                let dist = abs_line.abs_diff(ann.start_line.max(1) as usize);
                if dist < best_s_dist {
                  let s_col = ln[..byte_pos].chars().count() + 1;
                  let e_byte = byte_pos + head.len();
                  let e_col = ln[..e_byte].chars().count() + 1;
                  best_s = Some((abs_line, s_col, e_col));
                  best_s_dist = dist;
                }
              }
            }
            if let Some((s_abs, s_col1, _)) = best_s {
              let mut best_e: Option<(usize, usize, usize)> = None;
              let mut best_e_dist = usize::MAX;
              for (j, ln) in lines_vec.iter().enumerate().skip(s_abs.saturating_sub(ch2.start_line)) {
                if let Some(byte_pos) = ln.find(tail) {
                  let abs_line = ch2.start_line + j;
                  let dist = abs_line.abs_diff(ann.end_line.max(1) as usize);
                  if dist < best_e_dist {
                    let s_col = ln[..byte_pos].chars().count() + 1;
                    let e_byte = byte_pos + tail.len();
                    let e_col = ln[..e_byte].chars().count() + 1;
                    best_e = Some((abs_line, s_col, e_col));
                    best_e_dist = dist;
                  }
                }
              }
              if let Some((e_abs, _e_scol, e_col1)) = best_e {
                if e_abs >= s_abs { new_pos = Some((s_abs, e_abs, s_col1, e_col1)); }
              }
            }
          }
        }
      }
    }

    // 全文
    if new_pos.is_none() {
      if let Some(ref all) = full_text {
        let occs = find_all_positions(all, &ann.selected_text);
        if !occs.is_empty() {
          let anchor = ann.start_line.max(1) as usize;
          let mut best = occs[0];
          let mut best_dist = best.0.abs_diff(anchor);
          for o in occs.into_iter().skip(1) { let d = o.0.abs_diff(anchor); if d < best_dist { best = o; best_dist = d; } }
          new_pos = Some(best);
        }
      }
    }

    if let Some((s_line, e_line, s_col, e_col)) = new_pos {
      ann.start_line = s_line as i64;
      ann.end_line = e_line as i64;
      if ann.start_column.is_some() { ann.start_column = Some(s_col as i64); }
      if ann.end_column.is_some() { ann.end_column = Some(e_col as i64); }
      ann.updated_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| ann.updated_at);
      if let Some(ref d) = full_digest { ann.file_digest = Some(d.clone()); }
      if let Err(e) = state.store.update_annotation(&ann).await {
        tracing::warn!("verify: update failed for {}: {}", ann.id, e);
      } else { updated += 1; updated_ids.push(ann.id.clone()); }
    } else if remove_broken {
      if let Err(e) = state.store.delete_annotation(&ann.id).await {
        tracing::warn!("verify: delete failed for {}: {}", ann.id, e);
      } else { deleted += 1; deleted_ids.push(ann.id.clone()); }
    } else {
      skipped += 1; skipped_ids.push(ann.id.clone());
    }
  }

  Ok(VerifyResultOut { checked, updated, deleted, skipped, updated_ids, deleted_ids, skipped_ids })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::state::AppState;
  use ailoom_core::Annotation;
  use ailoom_fs::FsConfig;
  use ailoom_store::Store;
  use std::{fs, path::PathBuf};

  fn write_file(p: &PathBuf, content: &str) { fs::create_dir_all(p.parent().unwrap()).unwrap(); fs::write(p, content).unwrap(); }

  async fn make_state(tmpdir: &PathBuf) -> AppState {
    let root = tmpdir.clone();
    let workspace_root = root.clone();
    let fs_cfg = FsConfig::new(root.clone());
    let db = tmpdir.join("ailoom.db");
    let store = Store::connect_path(&db, &workspace_root.to_string_lossy()).await.unwrap();
    AppState { fs: fs_cfg, store, root, workspace_root }
  }

  fn new_ann(id: &str, file_path_ws_rel: &str, start: i64, end: i64, selected: &str) -> Annotation {
    Annotation {
      id: id.to_string(),
      file_path: file_path_ws_rel.to_string(),
      start_line: start,
      end_line: end,
      start_column: None,
      end_column: None,
      selected_text: selected.to_string(),
      comment: "t".into(),
      pre_context_hash: None,
      post_context_hash: None,
      file_digest: None,
      tags: None,
      priority: Some("P1".into()),
      created_at: "2020-01-01T00:00:00Z".into(),
      updated_at: "2020-01-01T00:00:00Z".into(),
    }
  }

  // 最小关键路径：找不到选区时会删除批注

  #[tokio::test]
  async fn verify_deletes_when_not_found() {
    let tmpdir = std::env::temp_dir().join(format!("ailoom_test_{}_2", uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmpdir).unwrap();
    let state = make_state(&tmpdir).await;
    let file_rel = "bar.txt";
    let fp = tmpdir.join(file_rel);
    write_file(&fp, "one\ntwo\nthree\n");
    let ann = new_ann("b1", file_rel, 1, 2, "one\ntwo");
    state.store.insert_annotation(&ann).await.unwrap();

    // 改成完全不同的内容
    write_file(&fp, "xxx\nyyy\nzzz\n");

    let r = verify_annotations_for_file(&state, file_rel, Some(40), Some(5 * 1024 * 1024), true).await.unwrap();
    assert_eq!(r.deleted, 1);
    assert!(state.store.get_annotation("b1").await.unwrap().is_none());
  }
}
