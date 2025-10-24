# WebSocket 改进规范

> 文档状态：提议
> 创建日期：2025-01-25
> 作者：Claude Code Review

## 1. 概述

本文档提出了对 AI-Loom WebSocket 实现的改进建议，旨在提升系统的稳定性、性能和可维护性。由于 AI-Loom 是本地应用，认证不是主要关注点，因此重点在于连接管理、性能优化和用户体验提升。

## 2. 改进目标

- **提升稳定性**：实现心跳机制和自动重连
- **优化性能**：减少不必要的消息传输，实现批量发送
- **改善体验**：选择性订阅，减少带宽占用
- **增强可观测性**：完善监控指标和调试工具

## 3. 技术方案

### 3.1 连接管理优化

#### 3.1.1 心跳机制

**目的**：及时检测和清理断开的连接，避免资源泄露

**后端实现**：
```rust
// packages/rust/ailoom-server/src/ws/client.rs
pub struct ClientConnection {
    id: String,
    socket: SplitSink<WebSocket, Message>,
    last_ping: Instant,
    last_pong: Instant,
}

impl ClientConnection {
    async fn heartbeat_loop(&mut self) {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;

            // 发送 ping
            if self.socket.send(Message::Ping(vec![])).await.is_err() {
                break;
            }

            // 检查 pong 响应
            if self.last_pong.elapsed() > Duration::from_secs(60) {
                tracing::warn!("Client {} heartbeat timeout", self.id);
                break;
            }
        }
    }
}
```

**前端实现**：
```typescript
// packages/web/src/lib/ws/ws-client.ts
class WsClient {
  private heartbeatInterval?: NodeJS.Timer;

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }
}
```

#### 3.1.2 连接状态管理

```rust
// packages/rust/ailoom-server/src/ws/hub.rs
pub struct ConnectionManager {
    connections: Arc<RwLock<HashMap<String, ConnectionInfo>>>,
    stats: Arc<ConnectionStats>,
}

pub struct ConnectionInfo {
    id: String,
    connected_at: Instant,
    last_activity: Instant,
    subscriptions: HashSet<String>,
    metadata: HashMap<String, String>,
}

pub struct ConnectionStats {
    total_connections: AtomicU64,
    active_connections: AtomicU64,
    messages_sent: AtomicU64,
    messages_received: AtomicU64,
    bytes_sent: AtomicU64,
    bytes_received: AtomicU64,
}
```

### 3.2 事件订阅机制

#### 3.2.1 选择性订阅

**目的**：客户端只接收感兴趣的事件，减少带宽占用

**协议设计**：
```typescript
// 订阅消息格式
interface SubscriptionMessage {
  type: 'subscribe' | 'unsubscribe';
  events: string[];  // 支持通配符，如 'file.*', 'annotations.created'
}

// 示例
ws.send(JSON.stringify({
  type: 'subscribe',
  events: ['file.changed', 'annotations.*']
}));
```

**后端实现**：
```rust
// packages/rust/ailoom-server/src/ws/subscription.rs
use globset::{Glob, GlobSet, GlobSetBuilder};

pub struct SubscriptionManager {
    subscriptions: HashMap<String, GlobSet>,
}

impl SubscriptionManager {
    pub fn subscribe(&mut self, client_id: &str, patterns: Vec<String>) -> Result<()> {
        let mut builder = GlobSetBuilder::new();
        for pattern in patterns {
            builder.add(Glob::new(&pattern)?);
        }
        self.subscriptions.insert(client_id.to_string(), builder.build()?);
        Ok(())
    }

    pub fn should_send(&self, client_id: &str, event: &str) -> bool {
        self.subscriptions
            .get(client_id)
            .map(|globs| globs.is_match(event))
            .unwrap_or(false)
    }
}
```

**前端封装**：
```typescript
// packages/web/src/lib/ws/ws-subscription.ts
export class WsSubscriptionManager {
  private subscriptions = new Set<string>();
  private ws: WebSocket;

  subscribe(patterns: string | string[]) {
    const events = Array.isArray(patterns) ? patterns : [patterns];

    events.forEach(e => this.subscriptions.add(e));

    this.ws.send(JSON.stringify({
      type: 'subscribe',
      events
    }));
  }

  unsubscribe(patterns: string | string[]) {
    const events = Array.isArray(patterns) ? patterns : [patterns];

    events.forEach(e => this.subscriptions.delete(e));

    this.ws.send(JSON.stringify({
      type: 'unsubscribe',
      events
    }));
  }

  // 自动管理 React 组件订阅
  useSubscription(patterns: string[], deps: any[] = []) {
    useEffect(() => {
      this.subscribe(patterns);
      return () => this.unsubscribe(patterns);
    }, deps);
  }
}
```

### 3.3 性能优化

#### 3.3.1 批量发送优化

**目的**：合并短时间内的多个事件，减少消息数量

```rust
// packages/rust/ailoom-server/src/ws/batcher.rs
pub struct MessageBatcher {
    pending: Arc<Mutex<Vec<Event>>>,
    flush_interval: Duration,
    max_batch_size: usize,
}

impl MessageBatcher {
    pub fn new(flush_interval: Duration, max_batch_size: usize) -> Self {
        let batcher = Self {
            pending: Arc::new(Mutex::new(Vec::new())),
            flush_interval,
            max_batch_size,
        };

        // 启动定期刷新任务
        let pending = batcher.pending.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(flush_interval);
            loop {
                interval.tick().await;
                let mut batch = pending.lock().unwrap();
                if !batch.is_empty() {
                    Self::flush_batch(&mut batch);
                }
            }
        });

        batcher
    }

    pub fn add(&self, event: Event) {
        let mut batch = self.pending.lock().unwrap();
        batch.push(event);

        if batch.len() >= self.max_batch_size {
            Self::flush_batch(&mut batch);
        }
    }

    fn flush_batch(batch: &mut Vec<Event>) {
        if batch.is_empty() {
            return;
        }

        let message = json!({
            "type": "batch",
            "events": batch.drain(..).collect::<Vec<_>>()
        });

        // 发送批量消息
        hub.broadcast("batch", message);
    }
}
```

#### 3.3.2 消息压缩

**适用场景**：大型文件内容、批注列表等大消息

```rust
// packages/rust/ailoom-server/src/ws/compression.rs
use flate2::write::GzEncoder;
use flate2::Compression;

pub fn compress_if_needed(message: &[u8], threshold: usize) -> Message {
    if message.len() > threshold {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(message).unwrap();
        let compressed = encoder.finish().unwrap();

        // 添加压缩标识
        let mut result = vec![0x01]; // 压缩标志
        result.extend_from_slice(&compressed);
        Message::Binary(result)
    } else {
        Message::Text(String::from_utf8_lossy(message).into_owned())
    }
}
```

#### 3.3.3 环形缓冲优化

```toml
# 建议的环境变量配置
AILOOM_WS_RING_CAP=4096         # 增加环形缓冲大小
AILOOM_WS_DEDUP_MS=500          # 增加去重窗口
AILOOM_WS_BATCH_INTERVAL_MS=50  # 批量发送间隔
AILOOM_WS_COMPRESS_THRESHOLD=1024 # 压缩阈值(字节)
```

### 3.4 错误恢复机制

#### 3.4.1 自动重连

```typescript
// packages/web/src/lib/ws/ws-reconnect.ts
export class ReconnectingWebSocket {
  private ws?: WebSocket;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private lastEventId?: string;

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;

      // 恢复断线前状态
      if (this.lastEventId) {
        this.resume(this.lastEventId);
      }
    };

    this.ws.onclose = (event) => {
      if (!event.wasClean && this.shouldReconnect()) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.eventId) {
        this.lastEventId = data.eventId;
      }
      this.handleMessage(data);
    };
  }

  private shouldReconnect(): boolean {
    return this.reconnectAttempts < this.maxReconnectAttempts;
  }

  private scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      30000 // 最大30秒
    );

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  private resume(lastEventId: string) {
    this.send({
      type: 'resume',
      lastEventId
    });
  }
}
```

#### 3.4.2 断线缓存

```typescript
// packages/web/src/lib/ws/ws-cache.ts
export class OfflineCache {
  private cache: Map<string, any> = new Map();
  private maxSize = 100;

  onDisconnect() {
    // 保存关键状态到 localStorage
    const critical = Array.from(this.cache.entries())
      .filter(([key]) => this.isCritical(key))
      .slice(0, 20);

    localStorage.setItem('ws_offline_cache', JSON.stringify(critical));
  }

  onReconnect() {
    // 恢复缓存
    const saved = localStorage.getItem('ws_offline_cache');
    if (saved) {
      const critical = JSON.parse(saved);
      critical.forEach(([key, value]: [string, any]) => {
        this.cache.set(key, value);
      });
      localStorage.removeItem('ws_offline_cache');
    }
  }

  private isCritical(key: string): boolean {
    // 关键数据：批注、当前文件等
    return key.startsWith('annotations.') ||
           key.startsWith('current_file.');
  }
}
```

### 3.5 监控与调试

#### 3.5.1 增强的调试面板

```typescript
// packages/web/src/lib/ws/ws-debug-panel-enhanced.tsx
interface WsDebugStats {
  // 连接信息
  connectionId: string;
  connectedAt: Date;
  connectionDuration: number;
  reconnectCount: number;

  // 消息统计
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;

  // 性能指标
  averageLatency: number;
  maxLatency: number;
  minLatency: number;

  // 错误统计
  errorCount: number;
  lastError?: string;

  // 订阅信息
  subscriptions: string[];

  // 缓冲状态
  ringBufferSize: number;
  ringBufferUsage: number;
  droppedEvents: number;
}

export function WsDebugPanelEnhanced() {
  const [stats, setStats] = useState<WsDebugStats>();
  const [messages, setMessages] = useState<any[]>([]);
  const [filter, setFilter] = useState('');

  return (
    <div className="ws-debug-panel-enhanced">
      {/* 连接状态 */}
      <ConnectionStatus stats={stats} />

      {/* 性能图表 */}
      <PerformanceChart stats={stats} />

      {/* 消息日志 */}
      <MessageLog messages={messages} filter={filter} />

      {/* 订阅管理 */}
      <SubscriptionManager subscriptions={stats?.subscriptions} />

      {/* 操作按钮 */}
      <DebugActions />
    </div>
  );
}
```

#### 3.5.2 性能指标收集

```rust
// packages/rust/ailoom-server/src/ws/metrics.rs
use prometheus::{Encoder, TextEncoder, Counter, Gauge, Histogram};

lazy_static! {
    static ref WS_CONNECTIONS: Gauge = register_gauge!(
        "ws_connections_active",
        "Number of active WebSocket connections"
    ).unwrap();

    static ref WS_MESSAGES_SENT: Counter = register_counter!(
        "ws_messages_sent_total",
        "Total number of WebSocket messages sent"
    ).unwrap();

    static ref WS_MESSAGES_RECEIVED: Counter = register_counter!(
        "ws_messages_received_total",
        "Total number of WebSocket messages received"
    ).unwrap();

    static ref WS_MESSAGE_SIZE: Histogram = register_histogram!(
        "ws_message_size_bytes",
        "Size of WebSocket messages in bytes"
    ).unwrap();

    static ref WS_LATENCY: Histogram = register_histogram!(
        "ws_roundtrip_latency_ms",
        "WebSocket roundtrip latency in milliseconds"
    ).unwrap();
}

pub async fn metrics_handler() -> impl IntoResponse {
    let encoder = TextEncoder::new();
    let metric_families = prometheus::gather();
    let mut buffer = vec![];
    encoder.encode(&metric_families, &mut buffer).unwrap();

    Response::builder()
        .header("Content-Type", encoder.format_type())
        .body(Body::from(buffer))
        .unwrap()
}
```

## 4. 实施计划

### Phase 1：基础改进（1周）
- [ ] 实现心跳机制
- [ ] 添加自动重连
- [ ] 增加环形缓冲大小

### Phase 2：性能优化（2周）
- [ ] 实现选择性订阅
- [ ] 添加批量发送
- [ ] 实现消息压缩

### Phase 3：监控增强（1周）
- [ ] 增强调试面板
- [ ] 添加性能指标
- [ ] 实现指标端点

## 5. 配置建议

```env
# .env.production
AILOOM_WS_RING_CAP=4096
AILOOM_WS_DEDUP_MS=500
AILOOM_WS_BATCH_INTERVAL_MS=50
AILOOM_WS_COMPRESS_THRESHOLD=1024
AILOOM_WS_HEARTBEAT_INTERVAL_SEC=30
AILOOM_WS_MAX_RECONNECT_ATTEMPTS=10
```

## 6. 测试策略

### 6.1 单元测试
- 心跳机制测试
- 订阅匹配测试
- 批量发送测试
- 压缩/解压测试

### 6.2 集成测试
- 断线重连测试
- 高并发连接测试
- 大消息传输测试
- 长时间运行稳定性测试

### 6.3 性能测试
- 消息吞吐量测试
- 延迟测试
- 内存占用测试
- CPU使用率测试

## 7. 兼容性考虑

- 所有改进都应该向后兼容
- 新功能通过配置开关控制
- 提供降级策略

## 8. 参考资料

- [WebSocket RFC 6455](https://tools.ietf.org/html/rfc6455)
- [socket.io 协议设计](https://socket.io/docs/v4/)
- [Phoenix Channels 设计](https://hexdocs.pm/phoenix/channels.html)