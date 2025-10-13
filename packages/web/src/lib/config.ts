export const TREE_CACHE_STALE_MS = 30_000 // 30s 内视为新鲜，避免频繁 refetch
export const TREE_CACHE_GC_MS = 5 * 60_000 // 5min 未访问则从缓存回收

