export type StatsSnap = {
  broadcastTotal?: number
  broadcastErrors?: number
  noReceiver?: number
  droppedRingLowpri?: number
  ringSize?: number
  ringCap?: number
  lastEventId?: number
  fileChangedTotal?: number
  treeChangedBatches?: number
  treeImpactedPathsTotal?: number
  treeTruncatedBatches?: number
  treeMovedTotal?: number
}

export function computeDelta(
  prev: StatsSnap | null,
  curr: StatsSnap | null,
  key: keyof StatsSnap
): number {
  if (!prev || !curr) return 0
  const a = (prev[key] as number | undefined) ?? 0
  const b = (curr[key] as number | undefined) ?? 0
  const d = b - a
  return d >= 0 ? d : 0
}

export function updateSeries(series: number[], value: number, cap = 12): number[] {
  const next = series.concat(Math.max(0, value))
  while (next.length > cap) next.shift()
  return next
}
