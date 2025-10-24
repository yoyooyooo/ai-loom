use ailoom_core::Annotation;

const HEADER_CHARS: &str = "> 说明: 片段中若发生省略，将使用 <<<OMITTED ~N CHARS>>> 进行标记；请勿臆测缺失内容，定位以文件路径与行号为准。\n\n";
const HEADER_LINES: &str = "> 说明: 片段中若发生省略，将使用 <<<OMITTED ~N LINES>>> 进行标记；请勿臆测缺失内容，定位以文件路径与行号为准。\n\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateId {
    Concise,
    Detailed,
}

impl TemplateId {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "detailed" => Self::Detailed,
            _ => Self::Concise,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StitchStats {
    pub total: usize,
    pub used: usize,
    pub truncated: bool,
    pub chars: usize,
}

pub struct StitchResult {
    pub prompt: String,
    pub stats: StitchStats,
}

pub fn generate_prompt(
    template: TemplateId,
    max_chars: usize,
    mut anns: Vec<Annotation>,
) -> StitchResult {
    // sort: priority -> file_path -> start_line
    fn prio_rank(p: &Option<String>) -> i32 {
        match p.as_deref() {
            Some("P0") => 0,
            Some("P1") => 1,
            Some("P2") => 2,
            _ => 3,
        }
    }
    anns.sort_by(|a, b| {
        prio_rank(&a.priority)
            .cmp(&prio_rank(&b.priority))
            .then(a.file_path.cmp(&b.file_path))
            .then(a.start_line.cmp(&b.start_line))
    });

    let heading = match template {
        TemplateId::Concise => "# Annotations (Concise)\n\n",
        TemplateId::Detailed => "# Annotations (Detailed)\n\n",
    };
    let assumed_header = match template {
        TemplateId::Concise => HEADER_CHARS,
        TemplateId::Detailed => HEADER_LINES,
    };

    let mut body = String::new();
    let mut omitted_any = false;
    let mut used = 0usize;
    for a in anns.iter() {
        // 选中文本：按模板做“中间省略”裁剪（concise 基于字符，detailed 基于行）
        let raw = a.selected_text.trim();
        let snippet = match template {
            TemplateId::Concise => collapse_middle_chars(raw, 60, 60, 120),
            TemplateId::Detailed => collapse_middle_lines(raw, 20, 20, 40),
        };

        // 省略检测（显式占位符）
        if snippet.contains("<<<OMITTED ~") {
            omitted_any = true;
        }

        // 若片段内含有三反引号，则用四反引号包裹，避免围栏冲突
        let fence = if snippet.contains("```") {
            "````"
        } else {
            "```"
        };

        let item = match template {
            TemplateId::Concise => format!(
                "- [{}:L{}-L{}] {}\n  {fence}\n{}\n{fence}\n\n",
                a.file_path, a.start_line, a.end_line, a.comment.trim(), snippet
            ),
            TemplateId::Detailed => format!(
                "- file: {}\n  span: L{}-L{}{}{}\n  tags: {}  priority: {}\n  comment: {}\n  selected:\n  {fence}\n{}\n{fence}\n\n",
                a.file_path,
                a.start_line, a.end_line,
                a.start_column.map(|c| format!(":{}", c)).unwrap_or_default(),
                a.end_column.map(|c| format!("-{}", c)).unwrap_or_default(),
                a.tags.as_ref().map(|v| v.join(",")).unwrap_or_default(),
                a.priority.clone().unwrap_or_else(|| "P1".into()),
                a.comment.trim(),
                snippet
            ),
        };
        // budget check（以包含“说明行”的最坏情况作为预算基准，避免后置插入导致超限）
        let base_len = heading.len() + assumed_header.len() + body.len();
        if base_len + item.len() > max_chars && used > 0 {
            break;
        }
        if base_len + item.len() > max_chars {
            // single item larger than budget: hard cut
            let remain = max_chars.saturating_sub(base_len);
            body.push_str(
                &item[..item
                    .char_indices()
                    .take_while(|(i, _)| *i < remain)
                    .map(|(_, c)| c)
                    .collect::<String>()
                    .len()
                    .min(item.len())],
            );
            used += 1;
            break;
        }
        body.push_str(&item);
        used += 1;
    }
    let truncated = used < anns.len();
    // 组装最终输出：标题 + （按需）说明 + 正文
    let mut out = String::new();
    out.push_str(heading);
    if omitted_any {
        out.push_str(assumed_header);
    }
    out.push_str(&body);
    let chars = out.len();
    StitchResult {
        prompt: out,
        stats: StitchStats {
            total: anns.len(),
            used,
            truncated,
            chars,
        },
    }
}

pub fn version() -> &'static str {
    "0.1.0"
}

// --- helpers: middle-ellipsis collapse ---

// concise：按字符预算做中间省略，保留前 head 与后 tail 字符；最大不超过 max_total 字符
fn collapse_middle_chars(s: &str, head: usize, tail: usize, max_total: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    if n <= max_total || n <= head + tail {
        return s.to_string();
    }
    let h = head.min(n);
    let t = tail.min(n.saturating_sub(h));
    let omitted = n.saturating_sub(h + t);
    let mut out = String::with_capacity(h + 32 + t);
    for c in &chars[0..h] {
        out.push(*c);
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format!("<<<OMITTED ~{} CHARS>>>\n", omitted));
    for c in &chars[n - t..n] {
        out.push(*c);
    }
    out
}

// detailed：按行数预算做中间省略，保留前 head 与后 tail 行；最大不超过 max_lines 行
fn collapse_middle_lines(s: &str, head: usize, tail: usize, max_lines: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let n = lines.len();
    if n <= max_lines || n <= head + tail {
        return s.to_string();
    }
    let h = head.min(n);
    let t = tail.min(n.saturating_sub(h));
    let omitted = n.saturating_sub(h + t);
    let mut out = String::new();
    for l in &lines[0..h] {
        out.push_str(l);
        out.push('\n');
    }
    out.push_str(&format!("<<<OMITTED ~{} LINES>>>\n", omitted));
    for l in &lines[n - t..n] {
        out.push_str(l);
        out.push('\n');
    }
    // 去掉末尾多余换行
    if out.ends_with('\n') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ann(id: &str, file: &str, text: &str, comment: &str) -> Annotation {
        Annotation {
            id: id.to_string(),
            file_path: file.to_string(),
            start_line: 1,
            end_line: 9999,
            start_column: None,
            end_column: None,
            selected_text: text.to_string(),
            comment: comment.to_string(),
            pre_context_hash: None,
            post_context_hash: None,
            file_digest: None,
            tags: None,
            priority: Some("P1".into()),
            created_at: "0".into(),
            updated_at: "0".into(),
        }
    }

    #[test]
    fn concise_with_omission_adds_header_once() {
        let long = "a".repeat(400);
        let r = generate_prompt(
            TemplateId::Concise,
            10_000,
            vec![ann("1", "a.rs", &long, "c1")],
        );
        assert!(
            r.prompt.contains("<<<OMITTED ~"),
            "snippet should contain omission marker"
        );
        assert!(r.prompt.contains("> 说明: 片段中若发生省略"));
        assert!(r.prompt.contains("CHARS>>>"));
        assert_eq!(
            r.prompt.matches("> 说明: 片段中若发生省略").count(),
            1,
            "header appears once"
        );
    }

    #[test]
    fn detailed_with_omission_adds_header_once() {
        let long_lines = (0..200)
            .map(|i| format!("line{}", i))
            .collect::<Vec<_>>()
            .join("\n");
        let r = generate_prompt(
            TemplateId::Detailed,
            50_000,
            vec![ann("1", "a.rs", &long_lines, "c1")],
        );
        assert!(r.prompt.contains("<<<OMITTED ~"));
        assert!(r.prompt.contains("LINES>>>"));
        assert!(r.prompt.contains("> 说明: 片段中若发生省略"));
        assert_eq!(r.prompt.matches("> 说明: 片段中若发生省略").count(), 1);
    }

    #[test]
    fn no_omission_no_header_and_no_extra_blank() {
        let short = "abcdefg";
        let r = generate_prompt(
            TemplateId::Concise,
            10_000,
            vec![ann("1", "a.rs", short, "c1")],
        );
        assert!(!r.prompt.contains("> 说明: 片段中若发生省略"));
        // 顶部应该是标题 + 空行，然后直接进入正文条目
        assert!(r.prompt.starts_with("# Annotations (Concise)\n\n- ["));
    }

    #[test]
    fn multiple_omissions_still_single_header() {
        let long1 = "x".repeat(400);
        let long2 = "y".repeat(500);
        let r = generate_prompt(
            TemplateId::Concise,
            50_000,
            vec![
                ann("1", "a.rs", &long1, "c1"),
                ann("2", "b.rs", &long2, "c2"),
            ],
        );
        assert!(r.prompt.contains("<<<OMITTED ~"));
        assert_eq!(r.prompt.matches("> 说明: 片段中若发生省略").count(), 1);
    }
}
