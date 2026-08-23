/**
 * 真实调用 DeepSeek 网页端原生 API，复现删除 / 重命名 / 分享等网页端操作。
 *
 * 双路径：
 * 1. 优先由 MAIN world 拦截器发请求（复用页面完整上下文 + 捕获的鉴权 token，
 *    服务端最可能正常处理）。
 * 2. 拦截器超时（postMessage 未响应）时，content script 直接同源 fetch 兜底
 *    （带 cookie + localStorage 兜底 token）。
 */

export interface NativeApiResult {
  ok: boolean
  status: number
  data?: unknown
  error?: string
}

const SOURCE = 'ds-sidebar-enhancer'
const SHARE_RE = /\/share\/([\w-]+)/

/** 拦截器捕获到的鉴权 token 缓存（content script 侧） */
let cachedToken = ''

/** 供拦截器把捕获到的 token 通过 bridge 消息写到这里 */
export function setNativeToken(token: string): void {
  if (token) cachedToken = token
}

function readToken(): string {
  if (cachedToken) return cachedToken
  for (const key of ['userToken', 'user_token', 'access_token', 'token']) {
    try {
      const v = localStorage.getItem(key)
      if (v) return v
    } catch {
      /* ignore */
    }
  }
  return ''
}

function resolveUrl(action: string): string {
  if (action === 'delete') return '/api/v0/chat_session/delete'
  if (action === 'rename') return '/api/v0/chat_session/update_title'
  if (action === 'share') return '/api/v0/chat_session/share'
  return ''
}

/** 路径一：通过 postMessage 让 MAIN world 拦截器发请求 */
function requestViaInterceptor(
  action: string,
  body: Record<string, unknown>,
  timeout = 3000,
): Promise<NativeApiResult | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: NativeApiResult | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(r)
    }
    const onMessage = (ev: MessageEvent) => {
      const msg = ev.data
      if (!msg || msg.source !== SOURCE || msg.type !== 'dsf-request-result') {
        return
      }
      if (msg.payload?.action !== action) return
      const p = msg.payload ?? {}
      finish({
        ok: p.ok === true,
        status: typeof p.status === 'number' ? p.status : 0,
        data: p.data,
        error: typeof p.error === 'string' ? p.error : undefined,
      })
    }
    const timer = setTimeout(() => finish(null), timeout)
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
    }
    window.addEventListener('message', onMessage)
    window.postMessage(
      { source: SOURCE, type: 'dsf-request', payload: { action, body } },
      '*',
    )
  })
}

/** 路径二：content script 直接同源 fetch（拦截器未响应时兜底） */
async function requestDirect(
  action: string,
  body: Record<string, unknown>,
): Promise<NativeApiResult> {
  const url = resolveUrl(action)
  if (!url) return { ok: false, status: 0, error: 'unsupported action' }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: window.location.origin,
    referer: window.location.href,
    'x-client-platform': 'web',
    'x-client-version': '2.0.2',
  }
  const token = readToken()
  if (token) headers['authorization'] = 'Bearer ' + token
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'include',
    })
    let data: unknown = null
    try {
      data = await res.clone().json()
    } catch {
      data = await res.text().catch(() => '')
    }
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, error: String(err) }
  }
}

async function requestNative(
  action: string,
  body: Record<string, unknown>,
): Promise<NativeApiResult> {
  // 优先拦截器（MAIN world）
  const viaInter = await requestViaInterceptor(action, body)
  if (viaInter) return viaInter
  // 兜底：content script 直接 fetch
  return requestDirect(action, body)
}

/** 重命名会话 */
export async function apiRenameChat(
  chatId: string,
  title: string,
): Promise<NativeApiResult> {
  return requestNative('rename', { chat_session_id: chatId, title })
}

/** 分享会话 */
export async function apiShareChat(
  chatId: string,
): Promise<NativeApiResult> {
  return requestNative('share', { chat_session_id: chatId })
}

/** 从分享接口响应中解析分享链接，兼容多种返回形状 */
export function extractShareUrl(
  data: unknown,
  fallbackId?: string,
): string | null {
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    for (const key of ['share_url', 'url', 'share_link', 'link', 'href']) {
      const v = o[key]
      if (typeof v === 'string' && /https?:\/\//.test(v)) return v
    }
    for (const key of ['share_id', 'share_code', 'id']) {
      const v = o[key]
      if (typeof v === 'string' && /[\w-]+/.test(v)) {
        const m = v.match(SHARE_RE)
        if (m) return `https://chat.deepseek.com/share/${m[1]}`
        if (/^[\w-]{8,}$/.test(v)) return `https://chat.deepseek.com/share/${v}`
      }
    }
  }
  if (typeof data === 'string') {
    const m = data.match(SHARE_RE)
    if (m) return `https://chat.deepseek.com/share/${m[1]}`
    if (/^https?:\/\//.test(data)) return data
  }
  if (fallbackId) {
    return `https://chat.deepseek.com/share/${fallbackId}`
  }
  return null
}
