import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  STORAGE_VERSION,
  type Folder,
  type FolderItem,
  type StorageSchema,
} from '@/types'
import {
  loadState,
  onStateChanged,
  saveStateDebounced,
} from '@/utils/storage'

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export const useFolderStore = defineStore('folder', () => {
  const folders = ref<Folder[]>([])
  const chatFolderMap = ref<Record<string, string>>({})
  const uncategorizedIds = ref<string[]>([])
  const rootItems = ref<FolderItem[]>([])
  const loaded = ref(false)
  /** 正在拖拽中的会话 id（用于全局拖拽视觉反馈） */
  const draggingChatId = ref<string | null>(null)
  /** 正在拖拽中的文件夹 id */
  const draggingFolderId = ref<string | null>(null)
  /** 当前处于行内重命名编辑态的文件夹 id（纯 UI 态，不持久化） */
  const editingFolderId = ref<string | null>(null)
  /**
   * 刚创建、尚未命名确认的文件夹 id（纯 UI 态，不持久化）。
   * 该文件夹在取消编辑或提交空名时自动回收，避免残留「新建文件夹」空壳。
   */
  const pendingNewFolderId = ref<string | null>(null)

  function folderById(id: string): Folder | undefined {
    return folders.value.find((f) => f.id === id)
  }

  /** 根级文件夹的顺序来源：rootItems 中的 folder 条目 */
  function rootFolderIds(): string[] {
    return rootItems.value
      .filter((it) => it.kind === 'folder')
      .map((it) => it.id)
  }

  /**
   * 获取某个父文件夹下的直接子文件夹列表（保持父 items 顺序）。
   * parentId 为 null 时按 rootItems 顺序。
   */
  function childrenOf(parentId: string | null): Folder[] {
    const ids =
      parentId === null
        ? rootFolderIds()
        : folderById(parentId)?.items
            .filter((it): it is Extract<FolderItem, { kind: 'folder' }> =>
              it.kind === 'folder',
            )
            .map((it) => it.id) ?? []
    const known = new Set(ids)
    return [
      ...ids
        .map((id) => folderById(id))
        .filter((f): f is Folder => !!f && f.parentId === parentId),
      ...folders.value
        .filter(
          (f) => (f.parentId ?? null) === parentId && !known.has(f.id),
        )
        .map((f) => f.id)
        .map((id) => folderById(id))
        .filter((f): f is Folder => !!f),
    ]
  }

  const rootFolders = computed<Folder[]>(() => childrenOf(null))

  function isDescendantOf(nodeId: string, ancestorId: string): boolean {
    let curId: string | null = nodeId
    while (curId) {
      const cur = folderById(curId)
      if (!cur) return false
      if (cur.parentId === ancestorId) return true
      curId = cur.parentId
    }
    return false
  }

  /** 收集某文件夹及其全部后代 id */
  function collectSubtreeIds(id: string): string[] {
    const result: string[] = []
    const queue = [id]
    while (queue.length) {
      const cur = queue.shift()!
      result.push(cur)
      for (const f of folders.value) {
        if ((f.parentId ?? null) === cur) queue.push(f.id)
      }
    }
    return result
  }

  /* ---------- 持久化 ---------- */
  function snapshot(): StorageSchema {
    return {
      version: STORAGE_VERSION,
      folders: folders.value.map((f) => ({
        ...f,
        items: f.items.map((it) => ({ ...it })),
      })),
      chatFolderMap: { ...chatFolderMap.value },
      uncategorizedIds: [...uncategorizedIds.value],
      rootItems: rootItems.value.map((it) => ({ ...it })),
    }
  }

  function persist(): void {
    saveStateDebounced(snapshot())
  }

  function applyState(state: StorageSchema): void {
    folders.value = state.folders
    chatFolderMap.value = state.chatFolderMap
    uncategorizedIds.value = state.uncategorizedIds
    rootItems.value = state.rootItems ?? []
  }

  let applyingRemote = false

  async function init(): Promise<void> {
    if (loaded.value) return
    const state = await loadState()
    applyState(state)
    loaded.value = true

    watch(
      [folders, chatFolderMap, uncategorizedIds, rootItems],
      () => {
        if (applyingRemote) return
        persist()
      },
      { deep: true },
    )

    onStateChanged((remote) => {
      applyingRemote = true
      applyState(remote)
      setTimeout(() => {
        applyingRemote = false
      }, 0)
    })
  }

  /* ---------- 文件夹 CRUD ---------- */
  function createFolder(name: string, parentId: string | null = null): Folder {
    const trimmed = name.trim() || '新建文件夹'
    const folder: Folder = {
      id: genId(),
      name: trimmed,
      parentId,
      collapsed: false,
      items: [],
    }
    folders.value.push(folder)
    // 挂到父序列末尾
    if (parentId === null) {
      rootItems.value.push({ kind: 'folder', id: folder.id })
    } else {
      const parent = folderById(parentId)
      if (parent) parent.items.push({ kind: 'folder', id: folder.id })
    }
    return folder
  }

  function renameFolder(id: string, name: string): void {
    const folder = folderById(id)
    const trimmed = name.trim()
    if (!folder || !trimmed || folder.name === trimmed) return
    folder.name = trimmed
  }

  /** 删除文件夹（含全部子文件夹）：组内所有对话回到未分类 */
  function deleteFolder(id: string): void {
    const idsToDelete = new Set(collectSubtreeIds(id))

    // 收集被删文件夹中的全部会话，保持相对顺序
    const restored: string[] = []
    for (const f of folders.value) {
      if (idsToDelete.has(f.id)) {
        for (const it of f.items) {
          if (it.kind === 'chat' && !restored.includes(it.id)) {
            restored.push(it.id)
          }
        }
      }
    }

    // 从各父级 items 中移除被删条目
    for (const f of folders.value) {
      if (!idsToDelete.has(f.id)) {
        f.items = f.items.filter((it) => !idsToDelete.has(it.id))
      }
    }
    rootItems.value = rootItems.value.filter((it) => !idsToDelete.has(it.id))

    folders.value = folders.value.filter((f) => !idsToDelete.has(f.id))
    for (const cid of restored) {
      delete chatFolderMap.value[cid]
    }
    const existing = new Set(uncategorizedIds.value)
    const toRestore = restored.filter((cid) => !existing.has(cid))
    if (toRestore.length) {
      uncategorizedIds.value = [...toRestore, ...uncategorizedIds.value]
    }
  }

  /** 子树统计：删除确认框使用 */
  function countFolderTree(
    id: string,
  ): { chatCount: number; folderCount: number } {
    const ids = new Set(collectSubtreeIds(id))
    let chatCount = 0
    for (const f of folders.value) {
      if (ids.has(f.id)) {
        chatCount += f.items.filter((it) => it.kind === 'chat').length
      }
    }
    return { chatCount, folderCount: ids.size }
  }

  function toggleCollapsed(id: string): void {
    const folder = folderById(id)
    if (folder) folder.collapsed = !folder.collapsed
  }

  /* ---------- 序列写入 ---------- */
  /** 从 vuedraggable 传入的元素中提取文件夹 id。
   * 同组排序时是 Folder；跨组（混排 mixed → 根级）拖入时是 MixedNode
   * （{ kind: 'folder', folder }）或原始对象，需兼容。 */
  function extractFolderId(n: unknown): string {
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>
      if (o.kind === 'folder' && typeof (o as { folder?: { id?: unknown } }).folder?.id === 'string') {
        return (o as { folder: { id: string } }).folder.id
      }
      if (typeof o.id === 'string') return o.id
    }
    return ''
  }

  /**
   * 覆盖根级文件夹顺序（vuedraggable setter）。
   * 同时把根级文件夹的 parentId 校正为 null。
   * 入参可能为 Folder / MixedNode / 原始对象，统一提取 id。
   */
  function setRootItems(items: unknown[]): void {
    const ids = items.map(extractFolderId).filter((id): id is string => id !== '')
    const next = [...new Set(ids)]
    for (const id of next) {
      const f = folderById(id)
      if (f) f.parentId = null
    }
    rootItems.value = next.map((id) => ({ kind: 'folder', id }))
  }

  /**
   * 覆盖某个文件夹的 items（vuedraggable setter，混排文件夹与对话）。
   * 同时 reconcile：folder 条目的 parentId 校正、chat 条目的 chatFolderMap 校正。
   * 被移出的对话回到未分类，被移出的子文件夹挂到原父级末尾。
   */
  function setFolderItems(folderId: string, items: FolderItem[]): void {
    const folder = folderById(folderId)
    if (!folder) return
    const prev = folder.items
    const next = [...new Set(items)]

    folder.items = next

    // chat 条目：校正映射
    const nextChatIds = new Set(
      next.filter((it) => it.kind === 'chat').map((it) => it.id),
    )
    const prevChatIds = new Set(
      prev.filter((it) => it.kind === 'chat').map((it) => it.id),
    )
    // 新增的 chat：建立映射并从未分类/其他文件夹移除
    for (const it of next) {
      if (it.kind !== 'chat') continue
      if (!prevChatIds.has(it.id)) {
        chatFolderMap.value[it.id] = folderId
        const ui = uncategorizedIds.value.indexOf(it.id)
        if (ui !== -1) uncategorizedIds.value.splice(ui, 1)
        for (const other of folders.value) {
          if (other.id === folderId) continue
          other.items = other.items.filter(
            (oi) => !(oi.kind === 'chat' && oi.id === it.id),
          )
        }
      }
    }
    // 被移出的 chat：解除映射并回未分类
    for (const cid of prevChatIds) {
      if (!nextChatIds.has(cid)) {
        delete chatFolderMap.value[cid]
        if (!uncategorizedIds.value.includes(cid)) {
          uncategorizedIds.value.unshift(cid)
        }
      }
    }

    // folder 条目：校正 parentId 为本文件夹
    for (const it of next) {
      if (it.kind !== 'folder') continue
      const child = folderById(it.id)
      if (child) child.parentId = folderId
    }
  }

  /* ---------- 层级与移动 ---------- */
  /**
   * 将某文件夹移动为另一文件夹的子级，并插入目标序列中的指定位置。
   * index 省略时插入目标序列末尾。
   */
  function moveFolderAsChild(
    folderId: string,
    parentId: string | null,
    index?: number,
  ): void {
    const folder = folderById(folderId)
    if (!folder) return
    if (
      parentId === folderId ||
      (parentId !== null && isDescendantOf(folderId, parentId))
    ) {
      return
    }
    // 从原父序列移除
    removeFolderFromParent(folderId, folder.parentId)
    folder.parentId = parentId
    // 插入目标序列
    if (parentId === null) {
      const list = rootItems.value.filter((it) => it.id !== folderId)
      const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length))
      list.splice(at, 0, { kind: 'folder', id: folderId })
      rootItems.value = list
    } else {
      const parent = folderById(parentId)
      if (parent) {
        const list = parent.items.filter((it) => it.id !== folderId)
        const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length))
        list.splice(at, 0, { kind: 'folder', id: folderId })
        parent.items = list
      }
    }
  }

  /** 从某父级序列中移除一个文件夹条目 */
  function removeFolderFromParent(
    folderId: string,
    parentId: string | null,
  ): void {
    if (parentId === null) {
      rootItems.value = rootItems.value.filter((it) => it.id !== folderId)
    } else {
      const parent = folderById(parentId)
      if (parent) {
        parent.items = parent.items.filter((it) => it.id !== folderId)
      }
    }
  }

  /* ---------- 对话归属 ---------- */
  /** 将单个会话移回未分类（拖到根级文件夹区域时使用） */
  function moveChatToUncategorized(chatId: string): void {
    const fid = chatFolderMap.value[chatId]
    if (fid) {
      const folder = folderById(fid)
      if (folder) {
        folder.items = folder.items.filter(
          (it) => !(it.kind === 'chat' && it.id === chatId),
        )
      }
      delete chatFolderMap.value[chatId]
    }
    if (!uncategorizedIds.value.includes(chatId)) {
      uncategorizedIds.value.unshift(chatId)
    }
  }

  /** 将单个会话移动到指定文件夹 items 的头部（折叠文件夹头部 drop 用） */
  function moveChatToFolder(chatId: string, folderId: string): void {
    const folder = folderById(folderId)
    if (!folder) return
    // 从原位置移除
    const prevFid = chatFolderMap.value[chatId]
    if (prevFid) {
      const prev = folderById(prevFid)
      if (prev) {
        prev.items = prev.items.filter(
          (it) => !(it.kind === 'chat' && it.id === chatId),
        )
      }
    }
    const ui = uncategorizedIds.value.indexOf(chatId)
    if (ui !== -1) uncategorizedIds.value.splice(ui, 1)
    folder.items = [
      { kind: 'chat', id: chatId },
      ...folder.items.filter(
        (it) => !(it.kind === 'chat' && it.id === chatId),
      ),
    ]
    chatFolderMap.value[chatId] = folderId
  }

  /** 覆盖未分类列表（拖拽 setter 用） */
  function setUncategorized(chatIds: string[]): void {
    const next = [...new Set(chatIds)]
    const prevSet = new Set(uncategorizedIds.value)
    // 新增的（从文件夹拖出）：解除映射并移除 folder items
    for (const cid of next) {
      if (!prevSet.has(cid)) {
        const fid = chatFolderMap.value[cid]
        if (fid) {
          const folder = folderById(fid)
          if (folder) {
            folder.items = folder.items.filter(
              (it) => !(it.kind === 'chat' && it.id === cid),
            )
          }
          delete chatFolderMap.value[cid]
        }
      }
    }
    uncategorizedIds.value = next.filter((cid) => !chatFolderMap.value[cid])
  }

  function sameStrArr(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  /**
   * 与最新会话全集同步：
   * - 清理已不存在会话的残留引用
   * - 新会话（无任何归属记录）追加到未分类头部
   */
  function syncSessions(allIds: string[]): void {
    const known = new Set(allIds)
    for (const folder of folders.value) {
      const filtered = folder.items.filter(
        (it) => it.kind === 'chat' ? known.has(it.id) : true,
      )
      if (filtered.length !== folder.items.length) folder.items = filtered
    }
    for (const cid of Object.keys(chatFolderMap.value)) {
      if (!known.has(cid)) delete chatFolderMap.value[cid]
    }
    const filteredUncat = uncategorizedIds.value.filter((id) =>
      known.has(id),
    )
    if (!sameStrArr(filteredUncat, uncategorizedIds.value)) {
      uncategorizedIds.value = filteredUncat
    }
    const assigned = new Set([
      ...Object.keys(chatFolderMap.value),
      ...uncategorizedIds.value,
    ])
    const newcomers = allIds.filter((id) => !assigned.has(id))
    if (newcomers.length) {
      uncategorizedIds.value = [...newcomers, ...uncategorizedIds.value]
    }
  }

  /** 会话被删除时的清理 */
  function pruneSession(chatId: string): void {
    const fid = chatFolderMap.value[chatId]
    if (fid) {
      const folder = folderById(fid)
      if (folder) {
        folder.items = folder.items.filter(
          (it) => !(it.kind === 'chat' && it.id === chatId),
        )
      }
      delete chatFolderMap.value[chatId]
    }
    const ui = uncategorizedIds.value.indexOf(chatId)
    if (ui !== -1) uncategorizedIds.value.splice(ui, 1)
  }

  return {
    folders,
    chatFolderMap,
    uncategorizedIds,
    rootItems,
    loaded,
    draggingChatId,
    draggingFolderId,
    editingFolderId,
    pendingNewFolderId,
    rootFolders,
    childrenOf,
    init,
    createFolder,
    renameFolder,
    deleteFolder,
    countFolderTree,
    toggleCollapsed,
    setRootItems,
    setFolderItems,
    moveFolderAsChild,
    moveChatToFolder,
    moveChatToUncategorized,
    setUncategorized,
    syncSessions,
    pruneSession,
  }
})
