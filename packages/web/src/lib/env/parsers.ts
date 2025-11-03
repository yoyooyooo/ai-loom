export const readEnvValue = (key: string): any => {
  try {
    return (import.meta as any)?.env?.[key]
  } catch {
    return undefined
  }
}

export const parseBoolean = (value: any, fallback: boolean): boolean => {
  if (value == null) return fallback
  if (typeof value === 'string') {
    const lowered = value.toLowerCase()
    if (lowered === '1' || lowered === 'true') return true
    if (lowered === '0' || lowered === 'false') return false
  }
  if (typeof value === 'number') return value !== 0
  return fallback
}

export const parseNumber = (value: any, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const parsePositiveNumber = (value: any, fallback: number): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return parsed > 0 ? parsed : fallback
}

export const parseNonNegativeNumber = (value: any, fallback: number): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return parsed >= 0 ? parsed : fallback
}
