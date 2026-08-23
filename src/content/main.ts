/**
 * ISOLATED world content script 入口（document_idle）：
 * 等待 DeepSeek 侧边栏就绪 → 隐藏原生对话列表 → 创建 Shadow DOM
 * 挂载 Vue 应用，并接通接口拦截消息桥与 DOM 兜底监听。
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import AppRoot from '@/sidebar/App.vue'
import sidebarCss from '@/sidebar/styles/main.css?inline'
import { onBridgeMessage } from '@/utils/bridge'
import {
  detectTheme,
  extractDesignTokens,
  extractSessionsFromDom,
  findChatListContainer,
  hideNativeChatList,
  hideNativeMultiSelect,
  isHiddenByUs,
  watchTheme,
  type DesignTokens,
} from '@/utils/native-dom'
import { useChatStore } from '@/stores/chat'
import { useFolderStore } from '@/stores/folder'
import { setNativeToken } from '@/utils/native-api'

const TAG = '[DS-Folders]'
const HOST_ID = 'ds-folders-enhancer-host'
const MOUNT_FLAG = 'data-ds-folders-mounted'

function debounce<T extends (...args: never[]) => void>(
  fn: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
}

/** 等待原生对话列表渲染完成（SPA 首屏异步渲染） */
function waitForChatList(timeoutMs = 30000): Promise<HTMLElement | null> {
  const existing = findChatListContainer()
  if (existing) return Promise.resolve(existing)

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      observer.disconnect()
      console.warn(`${TAG} 等待原生对话列表超时，放弃挂载`)
      resolve(null)
    }, timeoutMs)

    const observer = new MutationObserver(() => {
      const found = findChatListContainer()
      if (found) {
        clearTimeout(timer)
        observer.disconnect()
        resolve(found)
      }
    })
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
  })
}

function wireBridge(): void {
  const chatStore = useChatStore()
  onBridgeMessage((message) => {
    switch (message.type) {
      case 'sessions':
        console.info(
          `${TAG} 收到接口会话 ${message.payload.sessions.length} 条`,
        )
        chatStore.upsertSessions(message.payload.sessions)
        break
      case 'session-renamed':
        chatStore.renameSession(message.payload.id, message.payload.title)
        break
      case 'session-deleted':
        chatStore.removeSession(message.payload.id)
        break
      case 'interceptor-ready':
        console.info(`${TAG} 拦截器就绪`)
        break
      case 'dsf-location-changed':
        // SPA 路由变化：转发给侧边栏 App（当前会话高亮零延迟跟随）
        window.dispatchEvent(new CustomEvent('dsf-location-changed'))
        break
      case 'dsf-token':
        setNativeToken(message.payload.token)
        break
    }
  })
}

/**
 * 自愈与 DOM 兜底提取「彻底分离」：
 *
 * - 自愈（body MutationObserver）：仅当宿主被 DeepSeek 重建移除时复位，
 *   并保证原生列表保持隐藏。绝不调用 upsertSessions，避免在 DeepSeek
 *   高频页面变动下触发持续的状态同步→重渲染风暴。
 *   关键：宿主已连接时绝不移动它，避免拖拽/输入时焦点丢失。
 *
 * - 兜底提取（低频轮询 + 首帧种子）：每 3s 一次，签名守卫——
 *   DOM 内容未变时完全 no-op。接口拦截器为主数据源，此处仅作补充。
 */
function wireDomAndHealing(host: HTMLElement): void {
  const chatStore = useChatStore()
  let lastDomSig = ''

  /* ---- 兜底提取：签名守卫，稳定时零开销 ----
   * 同时承担「原生侧删除对账」：upsertSessions 只增不删，若拦截器的
   * session-deleted 未到达（未装上/未捕获），已删会话会永久残留在侧边栏。
   * 原生列表删除后 React 会移除对应行，故「上一轮在 DOM 中存在、
   * 连续两轮消失」的会话视为已删除，主动 removeSession 同步。
   * 两轮防抖：React 分组重排可能瞬时卸载行，单轮误删会丢失文件夹归属。 */
  let prevDomIds = new Set<string>()
  let missingStrikes = new Set<string>()

  /* ---- 删除确认框监听：原生弹框出现后监听用户点击（确认/取消/其他区域），
   *  点击立即对账，3s 内多轮补查（删除接口与行移除有异步延迟），
   *  随后放弃监听并完成清理；3s 内无任何点击同样放弃监听 ---- */
  let pendingDeleteId: string | null = null
  let pendingTimers: ReturnType<typeof setTimeout>[] = []

  function stopPendingWatch(): void {
    pendingDeleteId = null
    pendingTimers.forEach(clearTimeout)
    pendingTimers = []
  }

  function startPendingWatch(id: string): void {
    stopPendingWatch()
    pendingDeleteId = id

    const onPointerDown = (): void => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      clearTimeout(giveUpTimer)
      // 用户已对确认框做出反应：立即对账 + 3s 内补查，结束后清理
      extract()
      ;[300, 800, 1500, 2500].forEach((d) => {
        pendingTimers.push(setTimeout(extract, d))
      })
      pendingTimers.push(setTimeout(stopPendingWatch, 3000))
    }
    window.addEventListener('pointerdown', onPointerDown, true)

    // 3s 内用户未点击（离开/发呆）：放弃监听，清理
    const giveUpTimer = setTimeout(() => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      stopPendingWatch()
    }, 3000)
    pendingTimers.push(giveUpTimer)
  }

  const extract = (): void => {
    const sessions = extractSessionsFromDom()
    if (!sessions.length) return
    const ids = new Set(sessions.map((s) => s.id))

    // 待删目标已从原生 DOM 消失 → 用户意图明确，单轮即删（removeSession
    // 含文件夹/未分类清理）；拦截器路径若已移除，此处为幂等 no-op
    if (pendingDeleteId && !ids.has(pendingDeleteId)) {
      chatStore.removeSession(pendingDeleteId)
      console.info(`${TAG} 删除对账命中: ${pendingDeleteId}`)
      pendingDeleteId = null
    }

    // 通用对账（其它来源的删除）：连续两轮缺失判定，防分组重排瞬时卸载误删
    for (const id of missingStrikes) {
      if (!ids.has(id)) {
        chatStore.removeSession(id)
        console.info(`${TAG} DOM 对账：会话已删除 ${id}`)
      }
    }
    missingStrikes = new Set(
      [...prevDomIds].filter((id) => !ids.has(id)),
    )
    prevDomIds = ids

    const sig = sessions
      .map((s) => `${s.id}\u0001${s.title}`)
      .sort()
      .join('\n')
    if (sig === lastDomSig) return
    lastDomSig = sig
    console.info(`${TAG} DOM 提取 ${sessions.length} 条会话`)
    chatStore.upsertSessions(sessions)
  }

  extract()
  const seedTimers = [500, 1500, 3000, 6000].map((d) =>
    setTimeout(extract, d),
  )
  const extractInterval = setInterval(extract, 3000)

  /** 侧边栏派发：携带 watchId（原生确认框已弹出）时开启点击监听对账；
   *  否则仅补跑几轮提取 */
  const onExtractNow = (ev: Event): void => {
    const watchId = (ev as CustomEvent<{ watchId?: string }>).detail
      ?.watchId
    if (typeof watchId === 'string' && watchId) {
      startPendingWatch(watchId)
    } else {
      ;[150, 400, 800, 1300, 2000, 3000].forEach((d) =>
        setTimeout(extract, d),
      )
    }
  }
  window.addEventListener('dsf-extract-now', onExtractNow)

  /* ---- 自愈：宿主脱离 / 原生列表重现时复位 ---- */
  const heal = debounce((): void => {
    // 宿主仍连接：仅保证原生列表与多选按钮保持隐藏，绝不移动宿主（防焦点丢失）
    if (host.isConnected) {
      const list = findChatListContainer()
      if (list && !isHiddenByUs(list)) hideNativeChatList(list)
      hideNativeMultiSelect(list)
      return
    }
    // 宿主被移除（DeepSeek 重建侧边栏）：重新定位并复位
    const list = findChatListContainer()
    if (list?.parentElement) {
      hideNativeChatList(list)
      hideNativeMultiSelect(list)
      list.parentElement.insertBefore(host, list)
    }
  }, 500)

  const observer = new MutationObserver(heal)
  observer.observe(document.body, { childList: true, subtree: true })

  // 清理（页面卸载时）
  window.addEventListener('pagehide', () => {
    observer.disconnect()
    clearInterval(extractInterval)
    seedTimers.forEach(clearTimeout)
    stopPendingWatch()
    window.removeEventListener('dsf-extract-now', onExtractNow)
  })
}

/**
 * 将宿主提取的设计令牌以内联 CSS 变量写入 .dsf-root（优先级高于
 * 两套静态主题回退块）。rowHeight 在原生列表隐藏后不可测，保留上次值。
 * 返回当前生效的行高，供下次调用延续。
 */
function applyDesignTokens(
  el: HTMLElement,
  tokens: DesignTokens,
  prevRowHeight: number | null,
): number | null {
  const rowHeight = tokens.rowHeight ?? prevRowHeight
  if (tokens.surface) el.style.setProperty('--dsf-surface', tokens.surface)
  if (tokens.text) el.style.setProperty('--dsf-text', tokens.text)
  if (tokens.fontFamily) el.style.setProperty('--dsf-font', tokens.fontFamily)
  if (tokens.fontSize) el.style.setProperty('--dsf-font-size', tokens.fontSize)
  if (tokens.radius !== null) {
    el.style.setProperty('--dsf-radius', `${tokens.radius}px`)
  }
  if (rowHeight) el.style.setProperty('--dsf-row-h', `${rowHeight}px`)
  if (tokens.accent) el.style.setProperty('--dsf-accent', tokens.accent)
  return rowHeight
}

/**
 * 复刻原生列表的布局方式（flex 伸展 / 显式高度），使 host 成为与原生
 * 列表等高的自滚动容器 —— 不再依赖宿主父级的溢出行为。
 * 必须在隐藏原生列表之前调用（display:none 后无法测量高度）。
 */
function mimicNativeLayout(nativeList: HTMLElement, host: HTMLElement): void {
  const cs = window.getComputedStyle(nativeList)
  host.style.flexGrow = cs.flexGrow
  host.style.flexShrink = cs.flexShrink
  host.style.flexBasis = cs.flexBasis
  if (parseFloat(cs.flexGrow) === 0) {
    // 非 flex 伸展布局：退化为隐藏前实测高度
    const h = nativeList.getBoundingClientRect().height
    if (h > 0) host.style.height = `${Math.round(h)}px`
  }
  host.style.minHeight = '0'
  host.style.overflowY = 'auto'
}

async function bootstrap(): Promise<void> {
  if (document.documentElement.hasAttribute(MOUNT_FLAG)) return
  document.documentElement.setAttribute(MOUNT_FLAG, '1')

  const nativeList = await waitForChatList()
  if (!nativeList || !nativeList.parentElement) {
    console.warn(`${TAG} 未找到原生对话列表，跳过挂载`)
    return
  }

  // 宿主设计令牌：列表仍可见时提取（行高/圆角依赖布局测量）
  const tokens = extractDesignTokens()

  // Shadow DOM 宿主，插入到原生列表原本的位置
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.width = '100%'
  nativeList.parentElement.insertBefore(host, nativeList)
  // 复刻原生列表布局后再隐藏，让 host 接管滚动
  mimicNativeLayout(nativeList, host)
  hideNativeChatList(nativeList)
  const multiSelectHidden = hideNativeMultiSelect(nativeList)
  console.info(`${TAG} 已定位并隐藏原生列表`, nativeList)
  if (multiSelectHidden > 0) {
    console.info(`${TAG} 已隐藏原生多选按钮 ${multiSelectHidden} 个`)
  }

  const shadow = host.attachShadow({ mode: 'open' })
  const styleEl = document.createElement('style')
  styleEl.textContent = sidebarCss
  shadow.appendChild(styleEl)

  const mountEl = document.createElement('div')
  mountEl.className = 'dsf-root'
  if (detectTheme() === 'dark') mountEl.classList.add('dark')
  shadow.appendChild(mountEl)

  const pinia = createPinia()
  const app = createApp(AppRoot)
  app.use(pinia)
  app.mount(mountEl)

  const folderStore = useFolderStore(pinia)
  await folderStore.init()

  wireBridge()
  wireDomAndHealing(host)

  // 宿主令牌注入 + 主题切换时重提取（颜色类计算样式即时反映新主题）
  let rowHeight = applyDesignTokens(mountEl, tokens, null)
  watchTheme((mode) => {
    mountEl.classList.toggle('dark', mode === 'dark')
    rowHeight = applyDesignTokens(mountEl, extractDesignTokens(), rowHeight)
  })

  // 延迟重检：DeepSeek 可能懒加载多选按钮，多次尝试确保隐藏
  const recheckDelays = [1000, 3000, 5000, 10000]
  for (const delay of recheckDelays) {
    setTimeout(() => {
      const n = hideNativeMultiSelect(nativeList)
      if (n > 0) {
        console.info(`${TAG} 延迟 ${delay}ms 后又隐藏了 ${n} 个多选按钮`)
      }
    }, delay)
  }

  console.info(`${TAG} 侧边栏增强已挂载`)
}

void bootstrap()
