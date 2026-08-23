/**
 * 安装到页面 MAIN world 的 fetch/XHR 拦截器。
 *
 * 关键约束：本函数必须「自包含」——不得引用任何模块作用域的变量/常量/导入，
 * 因为它会通过 `installInterceptor.toString()` 以字符串形式同步注入到页面上下文执行，
 * 以赶在 DeepSeek 主包快照 `window.fetch` 之前完成打补丁。
 *
 * 字段解析放宽：兼容 id / session_id / chat_session_id / chat_id，
 * 以及 title / name / summary / topic，避免 DeepSeek 接口字段微调导致解析为空。
 */
export function installInterceptor(): void {
  const w = window as unknown as {
    __dsfInterceptorInstalled?: boolean
    fetch: typeof fetch
    XMLHttpRequest: typeof XMLHttpRequest
  }
  if (w.__dsfInterceptorInstalled) return
  w.__dsfInterceptorInstalled = true

  const SOURCE = 'ds-sidebar-enhancer'
  const SESSION_API = '/chat_session/'
  // 从页面真实请求头捕获的鉴权 token，供删除/重命名/分享等主动请求复用
  let cachedToken = ''
  const ID_FIELDS = ['id', 'session_id', 'chat_session_id', 'chat_id']
  const TITLE_FIELDS = ['title', 'name', 'summary', 'topic']
  const TAG = '[DS-Folders/inpage]'

  interface SessionLike {
    id: string
    title: string
    updatedAt?: number
  }

  function post(message: Record<string, unknown>): void {
    message.source = SOURCE
    window.postMessage(message, window.location.origin)
  }

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  }

  function pickString(
    obj: Record<string, unknown>,
    fields: string[],
  ): string | undefined {
    for (const f of fields) {
      const v = obj[f]
      if (typeof v === 'string' && v) return v
      if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    }
    return undefined
  }

  function extractSessions(payload: unknown, depth = 0): SessionLike[] {
    if (depth > 12 || payload == null) return []
    const found: SessionLike[] = []

    if (Array.isArray(payload)) {
      const like = payload.filter(
        (x) => isRecord(x) && pickString(x, ID_FIELDS) !== undefined,
      )
      if (like.length) {
        for (const item of like) {
          const id = pickString(item, ID_FIELDS)!
          const title = pickString(item, TITLE_FIELDS) || '未命名对话'
          const ua = item.updated_at
          const updatedAt =
            typeof ua === 'number' ? ua * 1000 : undefined
          found.push({ id, title, updatedAt })
        }
        return found
      }
      for (const x of payload) found.push(...extractSessions(x, depth + 1))
      return found
    }

    if (isRecord(payload)) {
      for (const v of Object.values(payload)) {
        found.push(...extractSessions(v, depth + 1))
      }
    }
    return found
  }

  function safeJson(text: string): unknown {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  function handle(url: string, body: string | null, payload: unknown): void {
    if (payload == null) return
    const sessions = extractSessions(payload)
    if (sessions.length) {
      console.info(`${TAG} 接口捕获 ${sessions.length} 条会话 <- ${url}`)
      post({ type: 'sessions', payload: { sessions } })
    }

    // 删除 / 重命名线索（从请求体提取）
    const b = body ? safeJson(body) : null
    if (isRecord(b)) {
      const id = pickString(b, ID_FIELDS)
      if (id) {
        if (url.includes('delete')) {
          post({ type: 'session-deleted', payload: { id } })
        } else if (
          (url.includes('update') || url.includes('rename')) &&
          typeof b.title === 'string' &&
          b.title.trim()
        ) {
          post({
            type: 'session-renamed',
            payload: { id, title: b.title.trim() },
          })
        }
      }
    }
  }

  /* ---------------- fetch 劫持 ---------------- */
  const origFetch = w.fetch
  w.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    captureAuth(init?.headers)
    const res = await origFetch.call(this, input, init)
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (url.includes(SESSION_API)) {
      const requestBody =
        init && typeof init.body === 'string' ? init.body : null
      res
        .clone()
        .json()
        .then((payload: unknown) => handle(url, requestBody, payload))
        .catch(() => {
          /* 非 JSON 响应，忽略 */
        })
    }
    return res
  }

  /* ---------------- XHR 劫持 ---------------- */
  const OrigXHR = w.XMLHttpRequest
  // 用 WeakMap 存储每实例状态，避免类字段声明（useDefineForClassFields 下
  // 会被编译成模块作用域辅助调用，破坏 .toString() 注入的自包含性）
  const xhrState = new WeakMap<
    XMLHttpRequest,
    { url: string; body: string | null }
  >()

  class PatchedXHR extends OrigXHR {
    setRequestHeader(name: string, value: string): void {
      if (String(name).toLowerCase() === 'authorization') {
        if (String(value).startsWith('Bearer ')) cachedToken = String(value)
      }
      return super.setRequestHeader(name, value)
    }

    open(
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ): void {
      xhrState.set(this, { url: String(url), body: null })
      return super.open(method, url, async ?? true, username, password)
    }

    send(body?: Document | XMLHttpRequestBodyInit | null): void {
      const state = xhrState.get(this)
      if (state) {
        state.body = typeof body === 'string' ? body : null
        if (state.url.includes(SESSION_API)) {
          this.addEventListener('load', () => {
            const st = xhrState.get(this)
            if (st) {
              handle(st.url, st.body, safeJson(this.responseText ?? ''))
            }
          })
        }
      }
      return super.send(body ?? null)
    }
  }
  w.XMLHttpRequest = PatchedXHR as typeof XMLHttpRequest

  /* ------------------------------------------------------------
   * 主动发起原生请求（删除 / 重命名 / 分享），复现网页端操作。
   * 由侧边栏通过 postMessage 触发，结果回传。
   * 使用未被 patch 的 origFetch 发起，避免自我递归与重复拦截。
   * ---------------------------------------------------------- */
  const API_PREFIX = '/api/v0'

  /** 从请求 init.headers 中捕获 authorization token（兼容 Headers/对象/数组） */
  function captureAuth(
    headers: HeadersInit | undefined,
  ): void {
    if (!headers) return
    let auth = ''
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      try {
        auth = headers.get('authorization') ?? ''
      } catch {
        auth = ''
      }
    } else if (Array.isArray(headers)) {
      const pair = headers.find(
        (h): h is [string, string] =>
          Array.isArray(h) && h[0].toLowerCase() === 'authorization',
      )
      auth = pair ? pair[1] : ''
    } else if (typeof headers === 'object') {
      const h = headers as Record<string, string>
      for (const key of Object.keys(h)) {
        if (key.toLowerCase() === 'authorization') {
          auth = h[key]
          break
        }
      }
    }
    if (auth && auth.startsWith('Bearer ') && auth !== cachedToken) {
      cachedToken = auth
      post({ type: 'dsf-token', payload: { token: auth } })
    }
  }

  function readToken(): string {
    if (cachedToken) return cachedToken
    // 兜底：从 localStorage 常见 key 读取
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

  function buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      origin: window.location.origin,
      referer: window.location.href,
      'x-client-platform': 'web',
      'x-client-version': '2.0.2',
    }
    const token = readToken()
    if (token) h['authorization'] = 'Bearer ' + token
    return h
  }

  async function sendRequest(
    action: string,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    let url = ''
    if (action === 'delete') url = API_PREFIX + '/chat_session/delete'
    else if (action === 'rename') url = API_PREFIX + '/chat_session/update_title'
    else if (action === 'share') url = API_PREFIX + '/chat_session/share'
    else {
      post({
        type: 'dsf-request-result',
        payload: { action, ok: false, status: 0, error: 'unsupported action' },
      })
      return
    }
    try {
      const res = await origFetch(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(payload ?? {}),
        credentials: 'include',
      })
      let data: unknown = null
      try {
        data = await res.clone().json()
      } catch {
        data = await res.text().catch(() => '')
      }
      post({
        type: 'dsf-request-result',
        payload: { action, ok: res.ok, status: res.status, data },
      })
    } catch (err) {
      post({
        type: 'dsf-request-result',
        payload: { action, ok: false, status: 0, error: String(err) },
      })
    }
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data
    if (!msg || msg.source !== SOURCE || msg.type !== 'dsf-request') return
    sendRequest(String(msg.payload?.action ?? ''), msg.payload?.body)
  })

  /* ---------------- SPA 路由监听 ----------------
   * pushState/replaceState 不触发 popstate，补丁后通知 content script，
   * 侧边栏当前会话高亮可零延迟跟随路由（替代高频轮询）。 */
  const origPush = history.pushState
  const origReplace = history.replaceState
  function notifyLocation(): void {
    post({ type: 'dsf-location-changed' })
  }
  history.pushState = function patchedPushState(
    this: History,
    ...args: Parameters<History['pushState']>
  ): void {
    origPush.apply(this, args)
    notifyLocation()
  }
  history.replaceState = function patchedReplaceState(
    this: History,
    ...args: Parameters<History['replaceState']>
  ): void {
    origReplace.apply(this, args)
    notifyLocation()
  }

  post({ type: 'interceptor-ready' })
  console.info(`${TAG} 拦截器已安装 (fetch+XHR)，SESSION_API="${SESSION_API}"`)
}
