# AI 代码修改追踪 - 并发修改处理方案

> 补充文档：处理 AI 和用户同时修改代码的场景
> 创建日期：2025-01-25

## 问题场景

在 AI 执行期间，用户可能也会手动修改文件，导致：
- AI 修改了文件 A
- 用户同时也修改了文件 A
- 如何区分哪些变更是 AI 做的，哪些是用户做的？

## 解决方案

### 1. 细粒度变更追踪

#### 1.1 记录每次文件变更

```rust
// packages/rust/ailoom-server/src/services/change_tracker.rs
pub struct DetailedFileChange {
    pub id: String,
    pub file_path: String,
    pub timestamp: DateTime<Utc>,
    pub trigger_source: TriggerSource,

    // 关键：记录变更的具体位置
    pub line_changes: Vec<LineChange>,

    // 变更前后的完整内容
    pub before_content: String,
    pub after_content: String,

    // 变更的 diff
    pub unified_diff: String,
}

pub struct LineChange {
    pub line_number: usize,
    pub change_type: LineChangeType, // Added/Deleted/Modified
    pub old_text: Option<String>,
    pub new_text: Option<String>,
}

pub enum TriggerSource {
    AI {
        conversation_id: String,
        message_id: String,
        operation_id: String,  // AI 的具体操作 ID
    },
    User {
        editor_session: Option<String>,
    },
    System,
}
```

#### 1.2 AI 操作拦截

**关键思路**：当 AI 要修改文件时，通过特定的 API 而不是直接写文件

```rust
// packages/rust/ailoom-server/src/services/ai_file_operations.rs
pub struct AIFileOperations {
    tracker: Arc<ChangeTracker>,
    current_operation: Arc<Mutex<Option<OperationContext>>>,
}

pub struct OperationContext {
    pub operation_id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub started_at: DateTime<Utc>,
}

impl AIFileOperations {
    // AI 修改文件必须通过这个方法
    pub async fn write_file(
        &self,
        path: &str,
        content: &str,
        context: OperationContext,
    ) -> Result<()> {
        // 1. 读取原始内容
        let old_content = fs::read_to_string(path).ok();

        // 2. 写入新内容
        fs::write(path, content)?;

        // 3. 记录这是 AI 的变更
        self.tracker.record_change(FileChange {
            id: Uuid::new_v4().to_string(),
            file_path: path.to_string(),
            timestamp: Utc::now(),
            trigger_source: TriggerSource::AI {
                conversation_id: context.conversation_id,
                message_id: context.message_id,
                operation_id: context.operation_id,
            },
            before_content: old_content.clone(),
            after_content: Some(content.to_string()),
            // 计算 line-level diff
            line_changes: compute_line_diff(&old_content, &Some(content.to_string())),
        }).await?;

        Ok(())
    }
}
```

#### 1.3 文件监听器检测用户修改

```rust
// packages/rust/ailoom-server/src/ws/watch.rs
impl FileWatcher {
    async fn on_file_modified(&self, path: PathBuf) {
        let path_str = path.to_string_lossy().to_string();

        // 检查这个修改是否来自 AI
        let is_ai_operation = self.ai_operations
            .current_operation
            .lock()
            .unwrap()
            .is_some();

        if is_ai_operation {
            // 这个修改已经被 AIFileOperations 记录了，跳过
            return;
        }

        // 这是用户的手动修改
        let old_content = self.tracker
            .get_last_known_content(&path_str)
            .await;
        let new_content = fs::read_to_string(&path).ok();

        self.tracker.record_change(FileChange {
            id: Uuid::new_v4().to_string(),
            file_path: path_str,
            timestamp: Utc::now(),
            trigger_source: TriggerSource::User {
                editor_session: None, // 可以从 WebSocket 连接获取
            },
            before_content: old_content,
            after_content: new_content.clone(),
            line_changes: compute_line_diff(&old_content, &new_content),
        }).await;
    }
}
```

### 2. 智能 Diff 合并

当同一个文件既有 AI 修改又有用户修改时：

```rust
// packages/rust/ailoom-server/src/services/diff_merger.rs
pub struct DiffMerger;

impl DiffMerger {
    /// 合并同一文件的多个变更记录
    pub fn merge_changes(
        file_path: &str,
        changes: Vec<FileChange>,
    ) -> MergedDiff {
        // 按时间排序
        let mut sorted = changes;
        sorted.sort_by_key(|c| c.timestamp);

        let mut ai_changes = Vec::new();
        let mut user_changes = Vec::new();

        for change in sorted {
            match change.trigger_source {
                TriggerSource::AI { .. } => ai_changes.push(change),
                TriggerSource::User { .. } => user_changes.push(change),
                _ => {}
            }
        }

        MergedDiff {
            file_path: file_path.to_string(),
            ai_changes,
            user_changes,
            conflicts: detect_conflicts(&ai_changes, &user_changes),
        }
    }
}

pub struct MergedDiff {
    pub file_path: String,
    pub ai_changes: Vec<FileChange>,
    pub user_changes: Vec<FileChange>,
    pub conflicts: Vec<ChangeConflict>,
}

pub struct ChangeConflict {
    pub line_number: usize,
    pub ai_change: LineChange,
    pub user_change: LineChange,
    pub resolution_required: bool,
}
```

### 3. 前端可视化展示

```typescript
// packages/web/src/features/review/components/concurrent-diff-viewer.tsx
interface ConcurrentDiffViewerProps {
  mergedDiff: MergedDiff;
}

export function ConcurrentDiffViewer({ mergedDiff }: ConcurrentDiffViewerProps) {
  return (
    <div className="concurrent-diff-viewer">
      {/* 三栏对比视图 */}
      <div className="three-way-diff">
        {/* 左侧：原始内容 */}
        <div className="original">
          <h3>原始版本</h3>
          <CodeEditor value={mergedDiff.baseContent} readOnly />
        </div>

        {/* 中间：AI 修改 */}
        <div className="ai-changes">
          <h3>AI 修改</h3>
          <CodeEditor
            value={applyChanges(mergedDiff.baseContent, mergedDiff.aiChanges)}
            decorations={highlightAIChanges(mergedDiff.aiChanges)}
            readOnly
          />
        </div>

        {/* 右侧：用户修改 */}
        <div className="user-changes">
          <h3>用户修改</h3>
          <CodeEditor
            value={applyChanges(mergedDiff.baseContent, mergedDiff.userChanges)}
            decorations={highlightUserChanges(mergedDiff.userChanges)}
            readOnly
          />
        </div>
      </div>

      {/* 冲突标记 */}
      {mergedDiff.conflicts.length > 0 && (
        <div className="conflicts-panel">
          <h3>⚠️ 检测到 {mergedDiff.conflicts.length} 处冲突</h3>
          {mergedDiff.conflicts.map(conflict => (
            <ConflictItem
              key={conflict.lineNumber}
              conflict={conflict}
              onResolve={handleResolveConflict}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 冲突项组件
function ConflictItem({ conflict, onResolve }: any) {
  return (
    <div className="conflict-item">
      <div className="conflict-location">
        第 {conflict.lineNumber} 行
      </div>

      <div className="conflict-options">
        <div className="ai-version">
          <h4>AI 修改</h4>
          <code>{conflict.aiChange.newText}</code>
          <Button onClick={() => onResolve('ai', conflict)}>
            采用 AI 版本
          </Button>
        </div>

        <div className="user-version">
          <h4>用户修改</h4>
          <code>{conflict.userChange.newText}</code>
          <Button onClick={() => onResolve('user', conflict)}>
            采用用户版本
          </Button>
        </div>

        <div className="manual-resolve">
          <h4>手动解决</h4>
          <Input
            defaultValue={conflict.aiChange.newText}
            onChange={(e) => onResolve('manual', conflict, e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
```

### 4. 时间线可视化

```typescript
// packages/web/src/features/review/components/change-timeline.tsx
export function ChangeTimeline({ changes }: { changes: FileChange[] }) {
  const groupedByFile = groupBy(changes, 'filePath');

  return (
    <div className="change-timeline">
      {Object.entries(groupedByFile).map(([file, fileChanges]) => (
        <div key={file} className="file-timeline">
          <h3>{file}</h3>

          {/* 时间轴 */}
          <div className="timeline">
            {fileChanges.map((change, index) => (
              <div
                key={change.id}
                className={cn(
                  'timeline-item',
                  change.triggerSource.type === 'AI' ? 'ai-change' : 'user-change'
                )}
              >
                <div className="time">{formatTime(change.timestamp)}</div>

                <div className="change-marker">
                  {change.triggerSource.type === 'AI' ? (
                    <Bot className="text-blue-500" />
                  ) : (
                    <User className="text-green-500" />
                  )}
                </div>

                <div className="change-details">
                  <div className="trigger">
                    {change.triggerSource.type === 'AI'
                      ? `AI (消息 #${change.triggerSource.messageId.slice(0, 8)})`
                      : '用户手动修改'}
                  </div>

                  <div className="stats">
                    +{change.lineChanges.filter(l => l.type === 'Added').length}{' '}
                    -{change.lineChanges.filter(l => l.type === 'Deleted').length}
                  </div>

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => showDiff(change)}
                  >
                    查看详情
                  </Button>
                </div>

                {/* 如果下一个变更时间很接近，显示警告 */}
                {index < fileChanges.length - 1 &&
                  isConflictPossible(change, fileChanges[index + 1]) && (
                    <div className="conflict-warning">
                      ⚠️ 可能存在冲突
                    </div>
                  )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function isConflictPossible(change1: FileChange, change2: FileChange): boolean {
  // 如果两个变更时间间隔很短（比如 < 5秒）
  const timeDiff = Math.abs(
    new Date(change2.timestamp).getTime() - new Date(change1.timestamp).getTime()
  );

  if (timeDiff > 5000) return false;

  // 并且一个是 AI，一个是用户
  const isDifferentSource =
    change1.triggerSource.type !== change2.triggerSource.type;

  return isDifferentSource;
}
```

### 5. Review 流程增强

```typescript
// packages/web/src/features/review/workflows/concurrent-review.ts
export class ConcurrentReviewWorkflow {
  async startReview(checkpointId: string) {
    // 1. 获取所有变更
    const allChanges = await api.getChanges(checkpointId);

    // 2. 按文件分组
    const byFile = groupBy(allChanges, 'filePath');

    // 3. 对每个文件进行分析
    const reviewItems = Object.entries(byFile).map(([file, changes]) => {
      const aiChanges = changes.filter(c => c.triggerSource.type === 'AI');
      const userChanges = changes.filter(c => c.triggerSource.type === 'User');

      return {
        file,
        hasAIChanges: aiChanges.length > 0,
        hasUserChanges: userChanges.length > 0,
        hasConcurrentChanges: aiChanges.length > 0 && userChanges.length > 0,
        changes: {
          ai: aiChanges,
          user: userChanges,
        },
        conflicts: detectConflicts(aiChanges, userChanges),
      };
    });

    return {
      total: reviewItems.length,
      aiOnly: reviewItems.filter(i => i.hasAIChanges && !i.hasUserChanges).length,
      userOnly: reviewItems.filter(i => !i.hasAIChanges && i.hasUserChanges).length,
      concurrent: reviewItems.filter(i => i.hasConcurrentChanges).length,
      withConflicts: reviewItems.filter(i => i.conflicts.length > 0).length,
      items: reviewItems,
    };
  }

  async reviewFile(file: string, decision: ReviewDecision) {
    switch (decision.type) {
      case 'accept-all':
        // 接受所有变更（AI + 用户）
        await api.acceptChanges(file);
        break;

      case 'accept-ai-only':
        // 只接受 AI 的变更，丢弃用户的
        const aiChanges = decision.changes.filter(c => c.triggerSource.type === 'AI');
        await api.applyChanges(file, aiChanges);
        break;

      case 'accept-user-only':
        // 只接受用户的变更，丢弃 AI 的
        const userChanges = decision.changes.filter(c => c.triggerSource.type === 'User');
        await api.applyChanges(file, userChanges);
        break;

      case 'manual-merge':
        // 手动合并
        await api.applyManualMerge(file, decision.mergedContent);
        break;

      case 'resolve-conflicts':
        // 解决冲突
        await api.resolveConflicts(file, decision.resolutions);
        break;
    }
  }
}
```

## 实施要点

### 关键设计原则

1. **每次文件变更都记录**
   - 不只是记录最终状态，而是记录每次变更
   - 包含时间戳、来源、具体修改内容

2. **AI 操作与文件监听解耦**
   - AI 通过专用 API 修改文件
   - 文件监听器检测到的就是用户修改
   - 通过这种方式天然区分来源

3. **冲突检测与解决**
   - 自动检测同一行的修改冲突
   - 提供三路合并视图
   - 支持手动解决冲突

4. **时间线可视化**
   - 按时间顺序展示所有变更
   - 用颜色/图标区分 AI vs 用户
   - 标注可能的冲突

## WebSocket 事件

```typescript
// 变更追踪事件
interface ChangeTrackedEvent {
  type: 'change.tracked';
  data: {
    changeId: string;
    filePath: string;
    triggerSource: 'ai' | 'user' | 'system';
    timestamp: string;
    summary: {
      additions: number;
      deletions: number;
    };
  };
}

// 冲突检测事件
interface ConflictDetectedEvent {
  type: 'conflict.detected';
  data: {
    filePath: string;
    lineNumber: number;
    aiChange: LineChange;
    userChange: LineChange;
  };
}
```

## 总结

通过这套方案，可以：

✅ **完全区分** AI 和用户的修改
✅ **实时追踪** 每次文件变更
✅ **自动检测** 并发修改冲突
✅ **可视化展示** 时间线和三路对比
✅ **灵活解决** 冲突（接受 AI/用户/手动合并）

这样即使 AI 和用户同时修改代码，系统也能清晰地展示谁改了什么，并帮助用户做出正确的决策。