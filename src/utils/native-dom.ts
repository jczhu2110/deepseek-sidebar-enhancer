/**
 * 与 DeepSeek 原生页面 DOM 交互的工具集：
 * 定位/隐藏原生对话列表、DOM 兜底提取会话、点击转发、主题检测。
 */
import type { ChatSession } from '@/types'
import { debugWarn } from '@/utils/debug'

const TAG = '[DS-Folders/dom]'
/** DeepSeek 会话链接特征：/a/chat/s/<chat_id> */
const CHAT_LINK_RE = /\/a\/chat\/s\/([\w-]+)/
const CHAT_LINK_SELECTOR = 'a[href*="/a/chat/s/"]'

export type NativeAction = 'rename' | 'share' | 'delete'

export function extractChatIdFromHref(href: string): string | null {
  const match = href.match(CHAT_LINK_RE)
  return match ? match[1] : null
}

/** 操作按钮关键词（中英文），用于在原生隐藏列表中定位 */
const ACTION_KEYWORDS: Record<NativeAction, string[]> = {
  rename: ['重命名', 'rename'],
  share: ['分享', 'share'],
  delete: ['删除', 'delete', '移除'],
}

function queryChatAnchors(root: ParentNode = document): HTMLAnchorElement[] {
  return Array.from(
    root.querySelectorAll<HTMLAnchorElement>(CHAT_LINK_SELECTOR),
  ).filter((a) => extractChatIdFromHref(a.href) !== null)
}

/**
 * 定位原生对话列表容器：
 * 1) 统计每个祖先包含的会话链接数；
 * 2) 优先返回「可滚动且包含 ≥50% 链接」的祖先（真正的列表滚动容器）；
 * 3) 退化：返回「包含 ≥80% 链接且 offsetHeight 最小」的祖先（最贴近列表本身）。
 *
 * 相比「第一个链接的祖先」，可避免误选到非侧边栏的单个链接（如顶栏当前会话）。
 */
export function findChatListContainer(): HTMLElement | null {
  const anchors = queryChatAnchors()
  if (!anchors.length) return null
  const total = anchors.length

  const scores = new Map<HTMLElement, number>()
  for (const a of anchors) {
    let node = a.parentElement
    while (node && node !== document.body) {
      scores.set(node, (scores.get(node) ?? 0) + 1)
      node = node.parentElement
    }
  }

  // 优先：可滚动容器
  let bestScroll: HTMLElement | null = null
  let bestScrollScore = 0
  for (const [el, score] of scores) {
    const oy = window.getComputedStyle(el).overflowY
    if ((oy === 'auto' || oy === 'scroll') && score > bestScrollScore) {
      bestScroll = el
      bestScrollScore = score
    }
  }
  if (bestScroll && bestScrollScore >= Math.max(1, Math.floor(total * 0.5))) {
    return bestScroll
  }

  // 退化：覆盖率高且最矮的祖先
  let best: HTMLElement | null = null
  let bestHeight = Infinity
  for (const [el, score] of scores) {
    if (score >= total * 0.8) {
      const h = el.offsetHeight || Infinity
      if (h < bestHeight) {
        best = el
        bestHeight = h
      }
    }
  }
  return best ?? anchors[0].parentElement
}

/** 隐藏原生对话列表（保留在 DOM 中用于兜底提取与点击转发） */
export function hideNativeChatList(container: HTMLElement): void {
  container.style.setProperty('display', 'none', 'important')
  container.setAttribute('data-ds-folders-hidden', '1')
}

export function isHiddenByUs(el: HTMLElement): boolean {
  return el.getAttribute('data-ds-folders-hidden') === '1'
}

/* ---------- 原生「多选 / 批量选择」按钮隐藏 ---------- */

/** 多选按钮文本特征（中英文，buttonText 已统一小写） */
const MULTI_SELECT_TEXT_KEYS = [
  '多选',
  '批量选择',
  '批量操作',
  '选择对话',
  '选择聊天',
  'multi-select',
  'multiselect',
  'batch select',
  'select chats',
  'select conversations',
]
/** 多选按钮常见 lucide 图标特征（仅在侧边栏范围内信任图标匹配） */
const MULTI_SELECT_ICON_SELECTOR = [
  'svg[class*="lucide-square-check"]',
  'svg[class*="lucide-list-checks"]',
  'svg[class*="lucide-check-check"]',
  'svg[class*="lucide-square"]',
  'svg[class*="lucide-check"]',
].join(',')

/**
 * 检测按钮内的 SVG 是否包含勾选/多选特征路径（仅在侧边栏范围内使用）。
 * 匹配常见的 checkbox / checkmark 路径特征。
 */
function hasCheckmarkSvg(btn: HTMLElement): boolean {
  const paths = btn.querySelectorAll('svg path')
  for (const path of paths) {
    const d = path.getAttribute('d') ?? ''
    // 勾选路径通常包含折线 "M...L...L..." 模式（polyline 特征）
    if (/M\s*[\d.]+[, ][\d.]+.*L\s*[\d.]+[, ][\d.]+.*L\s*[\d.]+[, ][\d.]+/.test(d)) {
      return true
    }
  }
  // 也检测 svg 内是否有 polyline 元素（勾选图标常用）
  if (btn.querySelector('svg polyline')) return true
  return false
}

/**
 * 隐藏原生侧边栏的「多选 / 批量选择」入口按钮。
 * 该按钮位于列表上方工具栏，不在被隐藏的列表容器内，需单独定位；
 * 隐藏后原生批量选择模式不可进入（列表本身已被扩展接管）。
 * 传入 chatList 可复用已定位的列表容器以缩小扫描范围；
 * 返回本次新隐藏的按钮数。
 */
export function hideNativeMultiSelect(chatList?: HTMLElement | null): number {
  const hide = (btn: HTMLElement): void => {
    btn.style.setProperty('display', 'none', 'important')
    btn.setAttribute('data-ds-folders-hidden', '1')
  }
  const textMatch = (btn: HTMLElement): boolean => {
    const text = buttonText(btn)
    return MULTI_SELECT_TEXT_KEYS.some((k) =>
      text.includes(k.toLowerCase()),
    )
  }
  const iconMatch = (btn: HTMLElement): boolean => {
    return !!btn.querySelector(MULTI_SELECT_ICON_SELECTOR) || hasCheckmarkSvg(btn)
  }

  // 侧边栏范围：列表容器向上 5 层祖先（覆盖列表上方的工具栏）；
  // DeepSeek 侧边栏 DOM 嵌套较深，3 层可能不够
  let scope: ParentNode | null = null
  if (chatList) {
    let node: HTMLElement | null = chatList
    for (let i = 0; i < 5 && node.parentElement; i++) {
      node = node.parentElement
    }
    if (node && node !== document.body) scope = node
  }

  let count = 0
  if (scope) {
    const scoped = Array.from(
      scope.querySelectorAll<HTMLElement>('button,[role="button"],div[class*="btn"],div[class*="button"],span[class*="btn"],span[class*="button"]'),
    ).filter(
      (b) =>
        !isHiddenByUs(b) &&
        (textMatch(b) || iconMatch(b)),
    )
    for (const b of scoped) hide(b)
    count += scoped.length
    if (count > 0) return count
  }

  // 退化：全文档按文本匹配 + 侧边栏区域图标匹配
  const global = Array.from(
    document.querySelectorAll<HTMLElement>('button,[role="button"],div[class*="btn"],div[class*="button"],span[class*="btn"],span[class*="button"]'),
  ).filter((b) => {
    if (isHiddenByUs(b)) return false
    if (textMatch(b)) return true
    // 仅在侧边栏区域内做图标匹配（避免误伤主聊天区）
    if (chatList && chatList.contains(b)) return false
    const sidebar = chatList?.closest('[class*="sidebar"],[class*="side"],nav,aside')
    if (sidebar && sidebar.contains(b) && iconMatch(b)) return true
    return false
  })
  for (const b of global) hide(b)
  count += global.length
  return count
}

/** 原生「新对话」按钮文本特征（中英文，buttonText 已统一小写）。
 *  用于原生调色板检测：定位该按钮提取强调色 */
const NEW_CHAT_TEXT_KEYS = [
  '开启新对话',
  '开始新对话',
  '新建对话',
  '新对话',
  'new chat',
  'new conversation',
]

/** 从（可能已隐藏的）原生 DOM 中提取会话列表 —— 接口解析失败时的兜底 */
export function extractSessionsFromDom(): ChatSession[] {
  const anchors = queryChatAnchors()
  const sessions: ChatSession[] = []
  const seen = new Set<string>()
  for (const anchor of anchors) {
    const id = extractChatIdFromHref(anchor.href)
    if (!id || seen.has(id)) continue
    seen.add(id)
    let title = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!title) {
      title = (
        anchor.getAttribute('aria-label') ??
        anchor.getAttribute('title') ??
        ''
      ).trim()
    }
    sessions.push({ id, title: title || '未命名对话' })
  }
  return sessions
}

function findChatAnchor(chatId: string): HTMLAnchorElement | null {
  return (
    queryChatAnchors().find(
      (a) => extractChatIdFromHref(a.href) === chatId,
    ) ?? null
  )
}

/**
 * 从会话链接向上找「行容器」：包含少量操作按钮（≤4 个）的最近祖先，
 * 即原生 hover 操作按钮所在的对话行。
 */
function findRowContainer(anchor: HTMLAnchorElement): HTMLElement | null {
  let node = anchor.parentElement
  for (let i = 0; node && i < 8; i++) {
    const btns = Array.from(
      node.querySelectorAll<HTMLElement>('button,[role="button"]'),
    )
    if (btns.length > 0 && btns.length <= 4) return node
    node = node.parentElement
  }
  return null
}

function buttonText(btn: HTMLElement): string {
  return [
    btn.getAttribute('aria-label') ?? '',
    btn.getAttribute('title') ?? '',
    btn.textContent ?? '',
  ]
    .join(' ')
    .toLowerCase()
}

/** 在原生隐藏列表中定位指定会话的某个操作按钮 */
export function findActionButton(
  chatId: string,
  action: NativeAction,
): HTMLElement | null {
  const anchor = findChatAnchor(chatId)
  if (!anchor) return null
  const row = findRowContainer(anchor)
  if (!row) return null
  const keywords = ACTION_KEYWORDS[action]
  const btns = Array.from(
    row.querySelectorAll<HTMLElement>('button,[role="button"]'),
  )
  return (
    btns.find((b) =>
      keywords.some((k) => buttonText(b).includes(k.toLowerCase())),
    ) ?? null
  )
}

/* ---------- 原生行内操作触发：悬停渲染 + 「更多」子菜单 ---------- */

/**
 * 原生列表的行内操作按钮（更多/重命名等）多为悬停时才渲染（React 状态控制）。
 * 原生列表被扩展 display:none 隐藏后无法产生真实悬停，按钮不在 DOM 中。
 * 合成事件在 display:none 子树上同样会执行 React 处理器（事件委托在根节点），
 * 故对会话行派发 hover 事件序列即可强制按钮渲染。
 */
function dispatchHoverEvents(el: Element): void {
  const base = { bubbles: true, cancelable: true, view: window }
  const PointerCtor =
    typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent
  el.dispatchEvent(new PointerCtor('pointerover', base))
  el.dispatchEvent(new MouseEvent('mouseover', base))
  el.dispatchEvent(new PointerCtor('pointermove', base))
  el.dispatchEvent(new MouseEvent('mousemove', base))
  el.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }))
}

/**
 * 完整指针点击序列（pointerdown→mousedown→pointerup→mouseup→click）。
 * 部分弹层组件（Radix 等）在 pointerdown/mousedown 打开、在 click 触发，
 * 单发 click 可能无效；完整序列最贴近真实用户点击。
 */
function dispatchClickSequence(el: HTMLElement): void {
  const base = { bubbles: true, cancelable: true, view: window }
  const PointerCtor =
    typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent
  el.dispatchEvent(new PointerCtor('pointerdown', base))
  el.dispatchEvent(new MouseEvent('mousedown', base))
  el.dispatchEvent(new PointerCtor('pointerup', base))
  el.dispatchEvent(new MouseEvent('mouseup', base))
  el.dispatchEvent(new MouseEvent('click', base))
}

/** 派发 Escape 尝试关闭误开的弹层（候选按钮试错间隙使用） */
function dispatchEscape(): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 行内可交互元素的宽松特征：原生「更多」等按钮未必是 <button>，
 * 可能只是带点击处理器的 div/span/svg 容器，按类名特征兜底识别。
 * （[attr*="x" i] 为 CSS4 大小写不敏感匹配，Chrome 支持）
 */
const ACTIONABLE_SELECTOR = [
  'button',
  '[role="button"]',
  '[class*="more" i]',
  '[class*="menu" i]',
  '[class*="btn" i]',
  '[class*="button" i]',
  '[class*="icon" i]',
  '[class*="action" i]',
  '[class*="operate" i]',
  '[class*="trigger" i]',
].join(',')

/**
 * 会话行 = 恰好包含 1 个会话链接且含可交互元素的最近祖先。
 * 相比「按钮数 ≤4」的猜测，链接数 === 1 是行级的可靠判据。
 */
function findActionArea(anchor: HTMLAnchorElement): HTMLElement | null {
  let node: HTMLElement | null = anchor.parentElement
  for (let i = 0; node && i < 8; i++) {
    if (node.querySelectorAll(CHAT_LINK_SELECTOR).length > 1) return null
    if (node.querySelector(ACTIONABLE_SELECTOR)) return node
    node = node.parentElement
  }
  return null
}

/**
 * 收集会话行的可交互元素。关键：DeepSeek 的「更多」按钮是 <a> 的子元素
 * （标题与 ⋯ 同在链接内部），必须先搜 anchor 内部；旧布局（按钮在行级祖先）再退化。
 */
function collectActionables(anchor: HTMLAnchorElement): HTMLElement[] {
  const inner = Array.from(
    anchor.querySelectorAll<HTMLElement>(ACTIONABLE_SELECTOR),
  )
  if (inner.length) return inner
  const area = findActionArea(anchor)
  return area
    ? Array.from(area.querySelectorAll<HTMLElement>(ACTIONABLE_SELECTOR))
    : []
}

/** 去掉嵌套：只保留候选中最外层元素（容器优先于其内部 icon div） */
function outermostOnly(els: HTMLElement[]): HTMLElement[] {
  const set = new Set(els)
  return els.filter((el) => {
    let p = el.parentElement
    while (p) {
      if (set.has(p)) return false
      p = p.parentElement
    }
    return true
  })
}

/** 行内与关键词匹配的操作元素 */
function findKeywordButton(
  anchor: HTMLAnchorElement,
  keywords: string[],
): HTMLElement | null {
  const els = collectActionables(anchor)
  return (
    els.find((b) =>
      keywords.some((k) => buttonText(b).includes(k.toLowerCase())),
    ) ?? null
  )
}

/**
 * 「更多 (…)」按钮候选，按可能性排序：文本匹配 > 图标/类名特征
 * （DeepSeek 设计系统 ds-button / more / dots 等）> 其余未知元素
 * （操作区通常靠右，未知元素按 DOM 倒序取，最多试 3 个）。
 */
function pickMoreCandidates(anchor: HTMLAnchorElement): HTMLElement[] {
  const els = outermostOnly(collectActionables(anchor)).filter(
    (b) => !(b instanceof HTMLAnchorElement),
  )
  const byText = els.filter((b) => /更多|more|···|\.\.\./.test(buttonText(b)))
  const byHint = els.filter(
    (b) =>
      !byText.includes(b) &&
      (/more|menu|dots|ellipsis|operate|ds-button/i.test(
        String(b.className || ''),
      ) ||
        !!b.querySelector(
          'svg[class*="lucide-more"],svg[class*="lucide-ellipsis"]',
        )),
  )
  const rest = els
    .filter((b) => !byText.includes(b) && !byHint.includes(b))
    .reverse()
  return [...byText, ...byHint, ...rest].slice(0, 3)
}

/**
 * 点击/触发后观察弹层并返回目标菜单项 —— 推送式（零轮询延迟）：
 * MutationObserver 在菜单 DOM 渲染的同一批回调里立即匹配，
 * 而非按固定间隔轮询；未命中超时后派发 Escape 关闭误开的弹层。
 * 新增节点跨批次累积，兼容菜单分多次 mutation 完成挂载的情况。
 */
function openAndFind(
  trigger: (() => void) | HTMLElement,
  keywords: string[],
  timeoutMs: number,
): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    let settled = false
    const acc: Element[] = []
    const finish = (item: HTMLElement | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      observer.disconnect()
      if (item) resolve(item)
      else {
        dispatchEscape()
        setTimeout(() => resolve(null), 40)
      }
    }
    const observer = new MutationObserver((mutations) => {
      if (settled) return
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n instanceof Element) acc.push(n)
        }
      }
      if (!acc.length) return
      const item = pickMenuItem(acc, keywords)
      if (item) finish(item)
    })
    const timer = setTimeout(() => finish(null), timeoutMs)
    observer.observe(document.body, { childList: true, subtree: true })
    if (typeof trigger === 'function') trigger()
    else dispatchClickSequence(trigger)
  })
}

/**
 * 在新增节点中找目标菜单项：不依赖弹层容器的类名/role 猜测，
 * 直接找「短文本且含关键词」的叶子元素（菜单项文字即「删除」等，最短 = 最深叶子）。
 */
function pickMenuItem(roots: Element[], keywords: string[]): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestLen = Infinity
  for (const root of roots) {
    const els: Element[] = [root, ...root.querySelectorAll('*')]
    for (const el of els) {
      if (!(el instanceof HTMLElement)) continue
      const text = (el.textContent ?? '').trim().toLowerCase()
      if (!text || text.length > 24 || text.length >= bestLen) continue
      if (!keywords.some((k) => text.includes(k.toLowerCase()))) continue
      best = el
      bestLen = text.length
    }
  }
  return best
}

/** 行内按钮单次快查（无等待）：按钮常驻时零延迟命中 */
function tryInlineNow(
  anchor: HTMLAnchorElement,
  keywords: string[],
): boolean {
  const btn = findKeywordButton(anchor, keywords)
  if (!btn) return false
  dispatchClickSequence(btn)
  return true
}

/**
 * 悬停渲染兜底：仅当 ⋯ 等按钮为悬停挂载（初始不在 DOM）时才有意义。
 * 循环派发 hover 等待候选出现；期间若行内直接出现目标按钮则立即点击。
 */
async function tryHoverRendered(
  anchor: HTMLAnchorElement,
  keywords: string[],
): Promise<boolean> {
  const deadline = performance.now() + 500
  while (performance.now() < deadline && !pickMoreCandidates(anchor).length) {
    if (tryInlineNow(anchor, keywords)) return true
    dispatchHoverEvents(anchor)
    await sleep(80)
  }
  return tryInlineNow(anchor, keywords)
}

/**
 * 在保留触发元素几何信息的窗口内执行 fn：将隐藏方式从 display:none 临时
 * 切换为 visibility:hidden（布局尺寸保留、内容仍不可见），使弹层组件能按
 * 触发按钮的真实位置定位菜单（display:none 时 rect 全为 0，菜单会堆到视口左上角）；
 * 结束后恢复原状。data-ds-folders-hidden 属性不变，自愈逻辑不会干扰此窗口。
 */
async function withTriggerGeometry<T>(
  anchor: HTMLElement,
  fn: () => Promise<T>,
): Promise<T> {
  const hidden = anchor.closest<HTMLElement>('[data-ds-folders-hidden]')
  if (!hidden) return fn()
  const prevDisplay = hidden.style.getPropertyValue('display')
  const prevPriority = hidden.style.getPropertyPriority('display')
  try {
    hidden.style.removeProperty('display')
    hidden.style.setProperty('visibility', 'hidden', 'important')
    return await fn()
  } finally {
    hidden.style.removeProperty('visibility')
    if (prevDisplay) {
      hidden.style.setProperty('display', prevDisplay, prevPriority || '')
    }
  }
}

/** 策略：「更多 (…)」子菜单 —— 主路径（DeepSeek 的 ⋯ 按钮常驻 <a> 内部，零等待起跑） */
async function tryMoreMenu(
  anchor: HTMLAnchorElement,
  keywords: string[],
): Promise<boolean> {
  const cands = pickMoreCandidates(anchor)
  if (!cands.length) return false
  return withTriggerGeometry(anchor, async () => {
    for (const cand of cands) {
      const item = await openAndFind(cand, keywords, 650)
      if (item) {
        dispatchClickSequence(item)
        return true
      }
    }
    return false
  })
}

/** 策略三：右键上下文菜单（部分客户端在会话行上提供删除/重命名右键菜单） */
async function tryContextMenu(
  anchor: HTMLAnchorElement,
  keywords: string[],
): Promise<boolean> {
  const fire = () => {
    dispatchHoverEvents(anchor)
    anchor.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 2,
        buttons: 2,
      }),
    )
  }
  const item = await openAndFind(fire, keywords, 500)
  if (item) {
    dispatchClickSequence(item)
    return true
  }
  return false
}

/**
 * 策略四：临时恢复原生列表可见性后重试。display:none 可能干扰列表渲染
 * （虚拟化按高度测量、悬停样式等），短暂还原再重隐藏。
 * 注：data-ds-folders-hidden 属性与实际 display 解耦，自愈逻辑在此期间
 * 不会重新隐藏列表（isHiddenByUs 只看属性）。
 */
async function tryUnhidden(
  anchor: HTMLAnchorElement,
  keywords: string[],
): Promise<boolean> {
  const hidden = anchor.closest<HTMLElement>('[data-ds-folders-hidden]')
  if (!hidden) return false
  const prevDisplay = hidden.style.getPropertyValue('display')
  const prevPriority = hidden.style.getPropertyPriority('display')
  try {
    hidden.style.removeProperty('display')
    await sleep(250)
    if (tryInlineNow(anchor, keywords)) return true
    const cand = pickMoreCandidates(anchor)[0]
    if (cand) {
      const item = await openAndFind(cand, keywords, 650)
      if (item) {
        dispatchClickSequence(item)
        return true
      }
    }
    return false
  } finally {
    if (prevDisplay) {
      hidden.style.setProperty('display', prevDisplay, prevPriority || '')
    }
  }
}

/** 失败诊断：输出会话行附近的 HTML 片段（截断），便于定位原生 DOM 结构 */
function diagnosticRowSnippet(anchor: HTMLAnchorElement): string {
  let node: HTMLElement | null = anchor.parentElement
  let row: HTMLElement = anchor
  for (let i = 0; node && i < 8; i++) {
    row = node
    if (node.querySelectorAll(CHAT_LINK_SELECTOR).length > 1) break
    node = node.parentElement
  }
  return row.outerHTML.replace(/\s+/g, ' ').slice(0, 1500)
}

/**
 * 触发原生操作（删除/分享等），让 DeepSeek 原生逻辑（确认框、接口调用）完整执行。
 *
 * 策略按「已知 DOM 结构 → 未知兜底」排序，常态路径零等待：
 * 1) 行内按钮单次快查（常驻时零延迟）；
 * 2) 主路径「更多 (…)」菜单：候选常驻 <a> 内部，直接点击（推送式观察器定位弹层目标项）；
 * 3) 悬停渲染兜底：仅当 ⋯ 不在 DOM 时才等待，出现后再走一次菜单路径；
 * 4) 右键上下文菜单；
 * 5) 临时恢复列表可见性后重试。
 * 全部失败时输出行结构诊断日志；返回 false 由调用方降级。
 */
export async function triggerNativeAction(
  chatId: string,
  action: NativeAction,
): Promise<boolean> {
  const anchor = findChatAnchor(chatId)
  if (!anchor) {
    debugWarn(`${TAG} 未找到原生会话节点: ${chatId}`)
    return false
  }
  const keywords = ACTION_KEYWORDS[action]

  // 1) 行内按钮快查（零延迟）
  if (tryInlineNow(anchor, keywords)) return true

  // 2) 主路径：更多菜单（候选常驻）
  const hadCandidates = pickMoreCandidates(anchor).length > 0
  if (await tryMoreMenu(anchor, keywords)) return true

  // 3) 悬停渲染兜底：仅当候选原本不在 DOM 时才值得等待（候选已存在却失败，重试同样点击无意义）
  if (!hadCandidates) {
    if (await tryHoverRendered(anchor, keywords)) return true
    if (await tryMoreMenu(anchor, keywords)) return true
  }

  // 4) 右键菜单 / 5) 临时恢复可见性重试
  if (await tryContextMenu(anchor, keywords)) return true
  if (await tryUnhidden(anchor, keywords)) return true

  debugWarn(`${TAG} 未找到原生「${action}」按钮 (chat=${chatId})`)
  debugWarn(`${TAG} 行结构诊断:`, diagnosticRowSnippet(anchor))
  return false
}

/** 给 React 受控输入框设置值并触发 input 事件 */
function setNativeInputValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * 原生重命名：
 * 1) 触发原生「重命名」按钮进入编辑态；
 * 2) 轮询等待原生渲染出行内输入框（在隐藏的原生列表里）；
 * 3) 用原生 setter 填充新标题并派发 input 事件（React 受控组件）；
 * 4) 派发 Enter 提交，让原生逻辑执行更新接口。
 * 返回是否完整走完原生流程；false 表示原生入口未找到，调用方应降级。
 */
export async function nativeRenameSession(
  chatId: string,
  title: string,
): Promise<boolean> {
  if (!(await triggerNativeAction(chatId, 'rename'))) return false
  for (let i = 0; i < 14; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const anchor = findChatAnchor(chatId)
    if (!anchor) continue
    const row = findRowContainer(anchor) ?? anchor.parentElement
    const input = row?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="text"],input:not([type]),textarea',
    )
    if (!input) continue
    setNativeInputValue(input, title)
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    )
    return true
  }
  debugWarn(`${TAG} 原生重命名输入框未出现 (chat=${chatId})`)
  return false
}

/**
 * 点击转发：在隐藏的原生列表中找到对应会话的 <a> 并触发原生点击，
 * 保证 DeepSeek 的 SPA 路由与内部状态加载逻辑完整执行。
 * 找不到节点时返回 false，由调用方降级处理。
 */
export function clickNativeChat(chatId: string): boolean {
  const anchors = queryChatAnchors()
  const target = anchors.find(
    (a) => extractChatIdFromHref(a.href) === chatId,
  )
  if (!target) {
    debugWarn(`${TAG} 未找到原生会话节点: ${chatId}`)
    return false
  }
  target.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
  )
  return true
}

/* ---------- 宿主设计令牌提取（Host-Aligned 主题） ---------- */

/** 从原生 DOM 提取的设计令牌；null 表示该项不可用（由调用方保留回退值） */
export interface DesignTokens {
  /** 面板背景：自原生列表向上找到的第一个不透明背景（即侧边栏纸面） */
  surface: string | null
  /** 主文字色：原生对话项文字 */
  text: string | null
  /** 字体栈 */
  fontFamily: string | null
  /** 正文字号（如 "14px"） */
  fontSize: string | null
  /** 对话行高度（px）；原生列表被隐藏后无法测量，返回 null */
  rowHeight: number | null
  /** 对话行圆角（px） */
  radius: number | null
  /** 品牌强调色；仅当提取到「有彩色」时采纳（灰调说明不是品牌元素） */
  accent: string | null
}

/** 解析 rgb()/rgba() 计算色；oklch() 等现代色法返回 null */
function parseRgbChannels(
  color: string,
): { r: number; g: number; b: number } | null {
  const m = color.match(/^rgba?\(([^)]+)\)$/i)
  if (!m) return null
  const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number)
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) {
    return null
  }
  return { r: parts[0], g: parts[1], b: parts[2] }
}

/** 估计颜色不透明度（用于判断背景是否透明）；无法解析时按不透明处理 */
function alphaOf(color: string): number {
  if (!color || color === 'transparent') return 0
  const fn = color.match(/^rgba?\(([^)]+)\)$/i)
  if (fn) {
    const parts = fn[1].split(/[,/\s]+/).filter(Boolean)
    if (parts.length >= 4) {
      const a = Number(parts[3])
      if (Number.isFinite(a)) return a > 1 ? a / 100 : a
    }
    return 1
  }
  // 现代色法（oklch/color-mix）的显式 alpha："... / 0.5" 或 "... / 50%"
  const slash = color.match(/\/\s*([\d.]+%?)\s*\)$/i)
  if (slash) {
    const v = Number(slash[1])
    if (Number.isFinite(v)) return slash[1].endsWith('%') ? v / 100 : v
  }
  return 1
}

/**
 * 从原生侧边栏提取设计令牌（颜色 / 字体 / 行高 / 圆角 / 品牌色），
 * 供 content script 以内联 CSS 变量注入 .dsf-root，使扩展 UI 贴合宿主主题。
 * 颜色类令牌在原生列表隐藏后仍可读取（计算样式不依赖布局）；
 * rowHeight 依赖布局，仅列表可见时有效。
 */
export function extractDesignTokens(): DesignTokens {
  const list = findChatListContainer()
  const anchor = queryChatAnchors()[0] ?? null

  let surface: string | null = null
  let node: HTMLElement | null = list
  while (node && node !== document.documentElement) {
    const bg = getComputedStyle(node).backgroundColor
    if (bg && alphaOf(bg) > 0.5) {
      surface = bg
      break
    }
    node = node.parentElement
  }

  let text: string | null = null
  let fontFamily: string | null = null
  let fontSize: string | null = null
  let rowHeight: number | null = null
  let radius: number | null = null
  if (anchor) {
    const cs = getComputedStyle(anchor)
    text = cs.color
    fontFamily = cs.fontFamily
    fontSize = cs.fontSize
    let el: HTMLElement | null = anchor
    for (let i = 0; el && i < 3; i++) {
      const h = el.getBoundingClientRect().height
      if (h >= 24 && h <= 64) {
        rowHeight = Math.round(h)
        break
      }
      el = el.parentElement
    }
    el = anchor
    for (let i = 0; el && i < 3; i++) {
      const r = parseFloat(getComputedStyle(el).borderRadius)
      if (Number.isFinite(r) && r > 0 && r <= 16) {
        radius = r
        break
      }
      el = el.parentElement
    }
  }

  let accent: string | null = null
  const newChatBtn = Array.from(
    document.querySelectorAll<HTMLElement>('button,[role="button"]'),
  ).find((b) =>
    NEW_CHAT_TEXT_KEYS.some((k) => buttonText(b).includes(k.toLowerCase())),
  )
  if (newChatBtn) {
    const color = getComputedStyle(newChatBtn).color
    const rgb = parseRgbChannels(color)
    if (rgb && Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b) > 32) {
      accent = color
    }
  }

  return { surface, text, fontFamily, fontSize, rowHeight, radius, accent }
}

export type ThemeMode = 'dark' | 'light'

/**
 * 宿主实测信号：原生侧边栏纸面亮度（感知加权和）。
 * 与 DeepSeek 的换肤机制无关（类名 / data-theme / 纯变量切换均适用），
 * 是主题判定最可靠的依据；列表未渲染或背景全透明时返回 null。
 */
function isNativeSurfaceDark(): boolean | null {
  const list = findChatListContainer()
  let node: HTMLElement | null = list
  while (node && node !== document.documentElement) {
    const bg = getComputedStyle(node).backgroundColor
    const rgb = parseRgbChannels(bg)
    if (rgb && alphaOf(bg) > 0.5) {
      const luma =
        (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255
      return luma < 0.5
    }
    node = node.parentElement
  }
  return null
}

/**
 * 主题判定（多信号，按可靠性排序）：
 * 1) html / body 上的显式标记（class="dark" 或 data-theme="dark"）；
 * 2) 根元素 computed color-scheme 声明；
 * 3) 宿主实测：原生侧边栏纸面亮度（权威信号，跟随任何换肤机制）；
 * 4) 系统偏好兜底（仅前述信号均不可用时）。
 */
export function detectTheme(): ThemeMode {
  for (const el of [document.documentElement, document.body]) {
    const cls = el.classList
    const dataTheme = el.getAttribute('data-theme') ?? ''
    if (cls.contains('dark') || dataTheme === 'dark') return 'dark'
    if (cls.contains('light') || dataTheme === 'light') return 'light'
  }
  const scheme = getComputedStyle(document.documentElement).colorScheme
  if (/\bdark\b/i.test(scheme)) return 'dark'
  if (/\blight\b/i.test(scheme)) return 'light'
  const surfaceDark = isNativeSurfaceDark()
  if (surfaceDark !== null) return surfaceDark ? 'dark' : 'light'
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark'
  }
  return 'light'
}

/** 监听 html/body 的 class / data-theme 与系统主题变化 */
export function watchTheme(callback: (mode: ThemeMode) => void): () => void {
  const observer = new MutationObserver(() => callback(detectTheme()))
  const opts: MutationObserverInit = {
    attributes: true,
    attributeFilter: ['class', 'data-theme'],
  }
  observer.observe(document.documentElement, opts)
  observer.observe(document.body, opts)
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onMedia = () => callback(detectTheme())
  media.addEventListener?.('change', onMedia)
  callback(detectTheme())
  return () => {
    observer.disconnect()
    media.removeEventListener?.('change', onMedia)
  }
}
