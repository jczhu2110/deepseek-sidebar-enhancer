/**
 * vuedraggable / Sortable 的 group.put 过滤器：
 * 按被拖元素根节点的 data-dsf-kind 标记区分「文件夹」与「对话」，
 * 只允许对应类型放入，避免跨组拖拽把错误类型对象混入列表 model
 * （例如 ChatSession 被塞进 folders 数组导致模型污染、对话消失）。
 *
 * Sortable 调用 put 函数时参数为 (to, from, dragEl, event)，
 * dragEl 即被拖元素的原始 DOM 节点。
 */
function kindOf(args: unknown[]): string | null {
  const dragEl = args[2]
  if (!(dragEl instanceof HTMLElement)) return null
  return dragEl.dataset.dsfKind ?? null
}

/** 文件夹列表（根级/子级）只接受文件夹元素拖入 */
export const putFolderOnly = (...args: unknown[]): boolean =>
  kindOf(args) === 'folder'

/** 对话列表（未分类/组内）只接受对话元素拖入 */
export const putChatOnly = (...args: unknown[]): boolean =>
  kindOf(args) === 'chat'

/** 混排列表（文件夹内统一序列）接受文件夹或对话拖入 */
export const putMixed = (...args: unknown[]): boolean =>
  kindOf(args) === 'chat' || kindOf(args) === 'folder'

/* ------------------------------------------------------------------ */
/* 拖拽移出判定：对话只有「完全拖出父文件夹边界」后才允许变更归属。      */
/* 仍在源文件夹内视为误触/排序微调，drop 应放弃放置（回滚到原位置），   */
/* 归属保持不变。阈值随父文件夹大小自适应（以其 boundingRect 为界）。   */
/* ------------------------------------------------------------------ */

/** 当前拖拽会话上下文（各 draggable 的 @start 中记录） */
const dragSession = {
  /** 被拖对话所属的文件夹根元素；未分类对话 / 非对话拖拽为 null（无边界限制） */
  sourceFolderEl: null as HTMLElement | null,
  /** 被拖对话所属的文件夹 id；未分类对话 / 非对话拖拽为 null */
  sourceFolderId: null as string | null,
  active: false,
}

/**
 * 记录拖拽上下文。
 * @param sourceFolderEl 被拖对话所属的文件夹根元素；未分类对话或非对话拖拽传 null。
 * @param sourceFolderId 被拖对话所属的文件夹 id；未分类对话或非对话拖拽可不传。
 */
export function recordDragStart(
  sourceFolderEl?: HTMLElement | null,
  sourceFolderId?: string | null,
): void {
  dragSession.sourceFolderEl = sourceFolderEl ?? null
  dragSession.sourceFolderId = sourceFolderId ?? null
  dragSession.active = true
}

/** 清理拖拽会话（在 @end / 全局 dragend 中调用，幂等） */
export function resetDragSession(): void {
  dragSession.active = false
  dragSession.sourceFolderEl = null
  dragSession.sourceFolderId = null
}

/** 当前拖拽对话所属的源文件夹 id（未分类对话为 null） */
export function getSourceFolderId(): string | null {
  return dragSession.sourceFolderId
}

/**
 * 判断 drop 时指针是否已「完全移出」源文件夹的边界。
 * - 指针仍落在源文件夹 boundingRect 内 → 返回 false：调用方应放弃本次放置，
 *   不 preventDefault，让 Sortable 回滚到原位置，归属不变。
 * - 已完全移出；或没有源文件夹（未分类对话 / 非本扩展发起的拖拽）→ 返回 true，
 *   允许按 drop 落点执行移动。
 */
export function isOutsideSourceFolder(event: DragEvent): boolean {
  if (!dragSession.active) return true
  const el = dragSession.sourceFolderEl
  if (!el || !el.isConnected) return true
  const rect = el.getBoundingClientRect()
  const x = event.clientX
  const y = event.clientY
  const inside =
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  return !inside
}
