import { nanoid } from 'nanoid'

/**
 * 统一的前端唯一 ID 生成器。
 * 默认返回随机字符串，必要时可传入前缀便于排查。
 */
export function createId(prefix?: string) {
  const id = nanoid()
  return prefix ? `${prefix}_${id}` : id
}
