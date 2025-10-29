import axios, { type AxiosRequestConfig, type AxiosResponse, type Method } from 'axios'
import { defer, firstValueFrom, timer } from 'rxjs'
import { finalize, retry, tap } from 'rxjs/operators'

// 统一的 Axios 实例（跨 feature 复用）
// baseURL 来自 Vite 环境变量；未设置时走同源
const API_BASE = (import.meta as any).env?.VITE_API_BASE || ''

export const http = axios.create({
  baseURL: API_BASE || undefined,
  // 让 axios 基于 data 自动设置 Content-Type；如需跨域 Cookie 再按需开启：
  // withCredentials: true,
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
  const err: any = new Error(code + ':' + message)
  err.code = code
  err.status = status
  err.data = data
  err.raw = e
  return err
}

export type RxRequestOptions<T = any> = {
  method: Method
  url: string
  data?: any
  params?: any
  headers?: Record<string, string>
  timeoutMs?: number
  retries?: number
  backoffMs?: number
  signal?: AbortSignal
  // 透传更多 axios 配置（如需要）
  config?: AxiosRequestConfig<T>
}

// 兼容别名：对外暴露两种 API
export type RequestOptions<T = any> = RxRequestOptions<T>

// request$: 返回 Observable，可在调用侧自由组合 pipe（如并发控制、取消、进度等）
export function request$<T = any>(options: RxRequestOptions<T>) {
  const {
    method,
    url,
    data,
    params,
    headers,
    signal,
    timeoutMs = 60_000,
    retries = 0,
    backoffMs = 1000,
    config
  } = options

  return defer(() => {
    const controller = new AbortController()
    const abortBy = (reason?: any) => {
      try {
        controller.abort(reason)
      } catch {}
    }

    const onExternalAbort = () =>
      abortBy(signal?.reason || new DOMException('Aborted', 'AbortError'))
    if (signal) {
      if (signal.aborted) onExternalAbort()
      else signal.addEventListener('abort', onExternalAbort, { once: true })
    }

    const timerId =
      timeoutMs > 0
        ? setTimeout(() => abortBy(new DOMException('Timeout', 'AbortError')), timeoutMs)
        : undefined

    const req$ = defer(() =>
      http.request<T>({
        ...(config ?? {}),
        method,
        url,
        data,
        params,
        // 参数 headers 优先于 config.headers
        headers: { ...((config?.headers as any) ?? {}), ...(headers ?? {}) },
        signal: controller.signal
      })
    )

    const isIdempotent = ['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase())
    const shouldRetry = (err: any) => {
      if (!isIdempotent) return false
      const status = err?.response?.status as number | undefined
      const name = err?.name as string | undefined
      // axios CanceledError / DOM AbortError 不重试
      if (name === 'CanceledError' || name === 'AbortError') return false
      // 网络错误（无响应）可重试
      if (status == null) return true
      // 仅对常见可恢复状态码重试
      return [408, 429, 500, 502, 503, 504].includes(status)
    }

    let settled = false
    const markSettled = () => {
      settled = true
    }
    return req$.pipe(
      retry({
        count: retries,
        resetOnSuccess: true,
        delay: (err, retryCount) => {
          if (!shouldRetry(err)) throw err
          return timer(backoffMs * retryCount)
        }
      }),
      tap({
        next: markSettled,
        error: markSettled,
        complete: markSettled
      }),
      finalize(() => {
        if (timerId) clearTimeout(timerId)
        if (signal) signal.removeEventListener('abort', onExternalAbort)
        if (!settled) {
          // 若调用侧提前取消订阅，确保中止请求
          try {
            controller.abort()
          } catch {}
        }
      })
    )
  })
}

// request: Promise 版本，参数基本一致，仅包一层 firstValueFrom
export async function request<T = any>(options: RxRequestOptions<T>): Promise<AxiosResponse<T>> {
  return await firstValueFrom(request$<T>(options))
}

// 兼容旧命名：保留 rxRequest，内部复用 request
export async function rxRequest<T = any>(options: RxRequestOptions<T>): Promise<AxiosResponse<T>> {
  return await request<T>(options)
}

export default http
