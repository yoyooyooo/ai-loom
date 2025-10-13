import axios from 'axios'

// 统一的 Axios 实例（跨 feature 复用）
// baseURL 来自 Vite 环境变量；未设置时走同源
const API_BASE = (import.meta as any).env?.VITE_API_BASE || ''

export const http = axios.create({
  baseURL: API_BASE || undefined,
  headers: { 'content-type': 'application/json' },
  // 可按需添加超时：
  // timeout: 15000,
})

// 如需全局拦截器，可在此添加：
// http.interceptors.response.use(
//   (res) => res,
//   (err) => Promise.reject(err)
// )

// 统一错误包装：优先服务端 { error:{ code,message } }，否则拼接 HTTP_XXX 或 NETWORK
export function toHttpError(e: any, fallbackMsg: string) {
  const status = e?.response?.status
  const data = e?.response?.data
  const code = data?.error?.code || (status ? 'HTTP_' + status : 'NETWORK')
  const message = data?.error?.message || fallbackMsg
  return new Error(code + ':' + message)
}

export default http
