# 前端性能优化建议

> 文档状态：提议
> 创建日期：2025-01-25
> 作者：Claude Code Review

## 1. 概述

本文档基于对 AI-Loom 前端代码的分析，提出性能优化建议，旨在提升应用的响应速度和用户体验。

## 2. 当前性能状况

### 2.1 识别的瓶颈
1. **Monaco Editor 初始化较慢**：首次加载时需要下载和初始化编辑器
2. **大文件渲染**：虽然有分页机制，但仍可能在某些场景下卡顿
3. **React Query 缓存策略**：部分查询可能过于频繁
4. **组件重渲染**：某些组件缺少优化，导致不必要的重渲染

## 3. 优化方案

### 3.1 代码分割与懒加载

#### 3.1.1 Monaco Editor 懒加载

**目标**：减少初始包体积，提升首屏加载速度

```typescript
// packages/web/src/components/editor/monaco-lazy.tsx
import { lazy, Suspense } from 'react';

// 懒加载 Monaco Editor
const MonacoEditor = lazy(() =>
  import('./monaco-editor-full').then(module => ({
    default: module.MonacoEditorFull
  }))
);

const EditorSkeleton = () => (
  <div className="flex items-center justify-center h-full">
    <div className="text-muted-foreground">加载编辑器...</div>
  </div>
);

export function LazyMonacoEditor(props: any) {
  return (
    <Suspense fallback={<EditorSkeleton />}>
      <MonacoEditor {...props} />
    </Suspense>
  );
}

// 预加载策略
export function preloadMonaco() {
  import('./monaco-editor-full');
}

// 在路由级别预加载
export function useMonacoPreload() {
  useEffect(() => {
    // 用户进入 explorer 页面时开始预加载
    const timer = setTimeout(preloadMonaco, 1000);
    return () => clearTimeout(timer);
  }, []);
}
```

**使用**：
```typescript
// packages/web/src/features/explorer/pages/explorer-page.tsx
import { LazyMonacoEditor, useMonacoPreload } from '@/components/editor/monaco-lazy';

export function ExplorerPage() {
  useMonacoPreload();

  return (
    <div>
      <LazyMonacoEditor /* ... */ />
    </div>
  );
}
```

#### 3.1.2 路由级别代码分割

```typescript
// packages/web/src/app.tsx
import { lazy } from 'react';

// 路由懒加载
const ChatPage = lazy(() => import('@/pages/chat-page'));
const Explorer = lazy(() => import('@/routes/explorer'));

// 预加载下一个可能访问的路由
function useRoutePreload() {
  const location = useLocation();

  useEffect(() => {
    if (location.pathname === '/chat') {
      // 预加载 Explorer
      import('@/routes/explorer');
    } else if (location.pathname.startsWith('/explore')) {
      // 预加载 Chat
      import('@/pages/chat-page');
    }
  }, [location.pathname]);
}

function AppShell() {
  useRoutePreload();

  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/explore" element={<Explorer />} />
      </Routes>
    </Suspense>
  );
}
```

### 3.2 虚拟滚动优化

#### 3.2.1 文件树虚拟化

**适用场景**：大型项目的文件树可能有数千个节点

```typescript
// packages/web/src/features/explorer/components/file-tree-virtual.tsx
import { FixedSizeList } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';

interface VirtualFileTreeProps {
  entries: DirEntry[];
  onSelect: (path: string) => void;
  selectedPath?: string;
}

export function VirtualFileTree({ entries, onSelect, selectedPath }: VirtualFileTreeProps) {
  const flattenedEntries = useMemo(() => {
    // 将树形结构扁平化为列表
    return flattenTree(entries);
  }, [entries]);

  const Row = ({ index, style }: any) => {
    const entry = flattenedEntries[index];
    return (
      <div style={style}>
        <FileTreeNode
          entry={entry}
          selected={entry.path === selectedPath}
          onSelect={onSelect}
        />
      </div>
    );
  };

  return (
    <AutoSizer>
      {({ height, width }) => (
        <FixedSizeList
          height={height}
          width={width}
          itemCount={flattenedEntries.length}
          itemSize={28}
          overscanCount={5}
        >
          {Row}
        </FixedSizeList>
      )}
    </AutoSizer>
  );
}

// 树形结构扁平化
function flattenTree(entries: DirEntry[], level = 0): FlatEntry[] {
  const result: FlatEntry[] = [];

  for (const entry of entries) {
    result.push({ ...entry, level });
    if (entry.type === 'dir' && entry.expanded && entry.children) {
      result.push(...flattenTree(entry.children, level + 1));
    }
  }

  return result;
}
```

#### 3.2.2 批注列表虚拟化

```typescript
// packages/web/src/features/explorer/components/annotation-list-virtual.tsx
import { FixedSizeList } from 'react-window';

export function VirtualAnnotationList({ annotations }: { annotations: Annotation[] }) {
  const AnnotationRow = ({ index, style }: any) => {
    const annotation = annotations[index];
    return (
      <div style={style}>
        <AnnotationItem annotation={annotation} />
      </div>
    );
  };

  return (
    <AutoSizer>
      {({ height, width }) => (
        <FixedSizeList
          height={height}
          width={width}
          itemCount={annotations.length}
          itemSize={80}
          overscanCount={3}
        >
          {AnnotationRow}
        </FixedSizeList>
      )}
    </AutoSizer>
  );
}
```

### 3.3 React Query 优化

#### 3.3.1 优化缓存策略

```typescript
// packages/web/src/lib/api/query-config.ts
export const queryConfig = {
  // 文件树查询配置
  tree: {
    staleTime: 5 * 60 * 1000,      // 5分钟内认为是新鲜的
    gcTime: 30 * 60 * 1000,        // 缓存30分钟
    refetchOnWindowFocus: false,   // 窗口聚焦时不重新请求
    refetchOnReconnect: true,      // 重连时刷新
    retry: 2,                       // 失败重试2次
  },

  // 文件内容查询配置
  file: {
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  },

  // 批注查询配置
  annotations: {
    staleTime: 1 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,    // 批注需要及时更新
    retry: 2,
  },

  // 聊天历史配置
  chatHistory: {
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  }
};

// 应用配置
export function useOptimizedQuery<T>(
  queryKey: QueryKey,
  queryFn: QueryFunction<T>,
  type: keyof typeof queryConfig
) {
  return useQuery({
    queryKey,
    queryFn,
    ...queryConfig[type]
  });
}
```

#### 3.3.2 预取和乐观更新

```typescript
// packages/web/src/features/explorer/hooks/use-prefetch.ts
export function usePrefetchAdjacent(currentFile: string, files: string[]) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const currentIndex = files.indexOf(currentFile);
    if (currentIndex === -1) return;

    // 预取前后文件
    const toPrefetch = [
      files[currentIndex - 1],
      files[currentIndex + 1]
    ].filter(Boolean);

    toPrefetch.forEach(file => {
      queryClient.prefetchQuery({
        queryKey: ['file', file, 0, 1000],
        queryFn: () => fetchFile(file, 0, 1000),
        staleTime: 2 * 60 * 1000,
      });
    });
  }, [currentFile, files, queryClient]);
}

// 乐观更新批注
export function useCreateAnnotation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createAnnotation,
    onMutate: async (newAnnotation) => {
      // 取消进行中的查询
      await queryClient.cancelQueries({ queryKey: ['annotations'] });

      // 获取旧数据
      const previousAnnotations = queryClient.getQueryData(['annotations']);

      // 乐观更新
      queryClient.setQueryData(['annotations'], (old: Annotation[]) => [
        ...old,
        { ...newAnnotation, id: 'temp-' + Date.now() }
      ]);

      return { previousAnnotations };
    },
    onError: (err, newAnnotation, context) => {
      // 回滚
      queryClient.setQueryData(['annotations'], context?.previousAnnotations);
    },
    onSettled: () => {
      // 无论成功失败都重新获取
      queryClient.invalidateQueries({ queryKey: ['annotations'] });
    },
  });
}
```

### 3.4 组件优化

#### 3.4.1 React.memo 优化

```typescript
// packages/web/src/features/explorer/components/file-tree-item.tsx
export const FileTreeItem = memo(
  ({ entry, selected, onSelect }: FileTreeItemProps) => {
    const handleClick = useCallback(() => {
      onSelect(entry.path);
    }, [entry.path, onSelect]);

    return (
      <div
        className={cn(
          'file-tree-item',
          selected && 'selected'
        )}
        onClick={handleClick}
      >
        <FileIcon type={entry.type} />
        <span>{entry.name}</span>
      </div>
    );
  },
  // 自定义比较函数
  (prevProps, nextProps) => {
    return (
      prevProps.entry.path === nextProps.entry.path &&
      prevProps.selected === nextProps.selected
    );
  }
);
```

#### 3.4.2 useMemo 和 useCallback

```typescript
// packages/web/src/features/explorer/pages/explorer-page.tsx
export function ExplorerPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const { data: entries } = useQuery(['tree']);

  // 缓存过滤结果
  const filteredEntries = useMemo(() => {
    if (!searchTerm) return entries;

    return entries?.filter(entry =>
      entry.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [entries, searchTerm]);

  // 缓存事件处理器
  const handleSearch = useCallback((term: string) => {
    setSearchTerm(term);
  }, []);

  const handleFileSelect = useCallback((path: string) => {
    // 处理文件选择
    navigate(`/explore?file=${encodeURIComponent(path)}`);
  }, [navigate]);

  return (
    <div>
      <SearchBar onSearch={handleSearch} />
      <FileTree
        entries={filteredEntries}
        onSelect={handleFileSelect}
      />
    </div>
  );
}
```

### 3.5 Web Workers 优化

#### 3.5.1 大文件处理 Worker

```typescript
// packages/web/src/workers/file-processor.worker.ts
interface ProcessRequest {
  type: 'parse' | 'search' | 'format';
  content: string;
  options?: any;
}

self.addEventListener('message', async (event: MessageEvent<ProcessRequest>) => {
  const { type, content, options } = event.data;

  try {
    let result;

    switch (type) {
      case 'parse':
        result = parseCode(content, options);
        break;
      case 'search':
        result = searchInContent(content, options);
        break;
      case 'format':
        result = formatCode(content, options);
        break;
    }

    self.postMessage({ success: true, result });
  } catch (error) {
    self.postMessage({ success: false, error: error.message });
  }
});

// 使用 Worker
const worker = new Worker(
  new URL('../workers/file-processor.worker.ts', import.meta.url),
  { type: 'module' }
);

export function useFileProcessor() {
  const process = useCallback((type: string, content: string, options?: any) => {
    return new Promise((resolve, reject) => {
      worker.postMessage({ type, content, options });

      worker.onmessage = (event) => {
        if (event.data.success) {
          resolve(event.data.result);
        } else {
          reject(new Error(event.data.error));
        }
      };
    });
  }, []);

  return { process };
}
```

### 3.6 资源优化

#### 3.6.1 图片懒加载

```typescript
// packages/web/src/components/ui/lazy-image.tsx
export function LazyImage({ src, alt, className, ...props }: ImageProps) {
  const [imageSrc, setImageSrc] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            setImageSrc(src);
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '50px' }
    );

    if (imgRef.current) {
      observer.observe(imgRef.current);
    }

    return () => observer.disconnect();
  }, [src]);

  return (
    <img
      ref={imgRef}
      src={imageSrc}
      alt={alt}
      className={cn(className, isLoading && 'opacity-0')}
      onLoad={() => setIsLoading(false)}
      {...props}
    />
  );
}
```

#### 3.6.2 字体优化

```css
/* packages/web/src/styles/fonts.css */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap; /* 提升感知性能 */
  src: local('Inter'),
       url('/fonts/inter-400.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153; /* 基本拉丁字符 */
}

@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: local('JetBrains Mono'),
       url('/fonts/jetbrains-mono-400.woff2') format('woff2');
  unicode-range: U+0000-00FF;
}
```

```html
<!-- packages/web/index.html -->
<!-- 预加载关键字体 -->
<link rel="preload" href="/fonts/inter-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/jetbrains-mono-400.woff2" as="font" type="font/woff2" crossorigin>
```

### 3.7 构建优化

#### 3.7.1 Vite 配置优化

```typescript
// packages/web/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [
    react(),
    // 包体积分析
    visualizer({
      open: true,
      gzipSize: true,
      brotliSize: true,
    }),
  ],

  build: {
    // 代码分割
    rollupOptions: {
      output: {
        manualChunks: {
          // 编辑器单独打包
          'monaco': ['monaco-editor'],

          // React 生态
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],

          // UI 组件库
          'ui-vendor': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
            'cmdk',
            'vaul',
          ],

          // 工具库
          'utils': ['clsx', 'tailwind-merge', 'date-fns'],

          // 状态管理和数据获取
          'state': ['zustand', '@tanstack/react-query'],
        },

        // 文件命名
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },

    // 压缩
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
        pure_funcs: ['console.log', 'console.info'],
      },
      format: {
        comments: false,
      },
    },

    // 性能预算
    chunkSizeWarningLimit: 1000,

    // 资源内联限制
    assetsInlineLimit: 4096,
  },

  // 依赖预构建
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      'zustand',
      '@tanstack/react-query',
    ],
    exclude: ['@vite/client', '@vite/env'],
  },

  // 服务器配置
  server: {
    port: 3000,
    strictPort: false,
    hmr: {
      overlay: true,
    },
  },
});
```

## 4. 监控方案

### 4.1 性能监控

```typescript
// packages/web/src/lib/performance/monitor.ts
export class PerformanceMonitor {
  private static metrics: Map<string, number[]> = new Map();

  static measure(name: string, fn: () => void) {
    const start = performance.now();
    fn();
    const duration = performance.now() - start;

    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    this.metrics.get(name)!.push(duration);

    // 如果超过阈值，警告
    if (duration > 100) {
      console.warn(`Slow operation: ${name} took ${duration.toFixed(2)}ms`);
    }
  }

  static async measureAsync(name: string, fn: () => Promise<void>) {
    const start = performance.now();
    await fn();
    const duration = performance.now() - start;

    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    this.metrics.get(name)!.push(duration);

    if (duration > 500) {
      console.warn(`Slow async operation: ${name} took ${duration.toFixed(2)}ms`);
    }
  }

  static getMetrics() {
    const result: Record<string, any> = {};

    this.metrics.forEach((times, name) => {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const max = Math.max(...times);
      const min = Math.min(...times);

      result[name] = {
        count: times.length,
        avg: avg.toFixed(2),
        max: max.toFixed(2),
        min: min.toFixed(2),
      };
    });

    return result;
  }

  static reportWebVitals() {
    // 使用 web-vitals 库
    import('web-vitals').then(({ getCLS, getFID, getFCP, getLCP, getTTFB }) => {
      getCLS(console.log);
      getFID(console.log);
      getFCP(console.log);
      getLCP(console.log);
      getTTFB(console.log);
    });
  }
}

// 使用示例
export function MyComponent() {
  useEffect(() => {
    PerformanceMonitor.measure('component-mount', () => {
      // 初始化逻辑
    });
  }, []);
}
```

### 4.2 React DevTools Profiler

```typescript
// packages/web/src/components/profiler-wrapper.tsx
import { Profiler, ProfilerOnRenderCallback } from 'react';

const onRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  // 只在开发环境记录
  if (process.env.NODE_ENV === 'development') {
    if (actualDuration > 16) { // 超过一帧时间
      console.warn(`Slow render in ${id}:`, {
        phase,
        actualDuration: actualDuration.toFixed(2),
        baseDuration: baseDuration.toFixed(2),
      });
    }
  }
};

export function ProfilerWrapper({
  id,
  children
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}

// 使用
function App() {
  return (
    <ProfilerWrapper id="App">
      <AppContent />
    </ProfilerWrapper>
  );
}
```

## 5. 实施计划

### Phase 1：快速优化（1周）
- [ ] 实现 Monaco Editor 懒加载
- [ ] 优化 React Query 缓存策略
- [ ] 添加关键组件 memo
- [ ] 配置 Vite 代码分割

### Phase 2：深度优化（2周）
- [ ] 实现虚拟滚动
- [ ] 添加 Web Workers
- [ ] 优化构建配置
- [ ] 实现预加载策略

### Phase 3：监控完善（1周）
- [ ] 添加性能监控
- [ ] 集成 Web Vitals
- [ ] 建立性能基准
- [ ] 持续性能跟踪

## 6. 预期效果

| 指标 | 当前值（估计） | 目标值 | 提升 |
|-----|-------------|--------|-----|
| 首次内容绘制 (FCP) | ~2.5s | <1.5s | 40% |
| 最大内容绘制 (LCP) | ~3.5s | <2.5s | 30% |
| 首次输入延迟 (FID) | ~100ms | <50ms | 50% |
| 累积布局偏移 (CLS) | ~0.15 | <0.1 | 33% |
| 包体积 | ~2MB | <1.5MB | 25% |
| Time to Interactive | ~4s | <3s | 25% |

## 7. 注意事项

1. **渐进式实施**：优先实施影响大、成本低的优化
2. **兼容性测试**：确保优化不影响现有功能
3. **性能基准**：建立基准，持续监控
4. **用户体验**：优化不应牺牲用户体验
5. **测量优先**：先测量再优化，避免过早优化

## 8. 相关资源

- [React 性能优化官方文档](https://react.dev/learn/render-and-commit)
- [Vite 性能优化指南](https://vitejs.dev/guide/performance.html)
- [Web Vitals](https://web.dev/vitals/)
- [React Query 性能优化](https://tanstack.com/query/latest/docs/react/guides/performance)