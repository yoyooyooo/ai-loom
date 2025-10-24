import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format as formatT, parseISO } from 'date-fns'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 统一时间格式：yyyy-MM-dd HH:mm:ss（本地时区）
export function formatDateTime(input?: string | Date | null): string {
  try {
    if (!input) return '-'
    const d = typeof input === 'string' ? parseISO(input) : input
    const when = isNaN((d as Date).getTime()) && typeof input === 'string' ? new Date(input) : (d as Date)
    if (isNaN(when.getTime())) return '-'
    return formatT(when, 'yyyy-MM-dd HH:mm:ss')
  } catch {
    return '-'
  }
}

export function formatDateDay(input?: string | Date | null): string {
  try {
    if (!input) return '-'
    const d = typeof input === 'string' ? parseISO(input) : input
    const when = isNaN((d as Date).getTime()) && typeof input === 'string' ? new Date(input) : (d as Date)
    if (isNaN(when.getTime())) return '-'
    return formatT(when, 'yyyy-MM-dd')
  } catch {
    return '-'
  }
}
