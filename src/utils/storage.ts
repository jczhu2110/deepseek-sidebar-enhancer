import {
  STORAGE_KEY,
  STORAGE_VERSION,
  type Folder,
  type FolderItem,
  type StorageSchema,
} from '@/types'

const TAG = '[DS-Folders]'

export function defaultState(): StorageSchema {
  return {
    version: STORAGE_VERSION,
    folders: [],
    chatFolderMap: {},
    uncategorizedIds: [],
    rootItems: [],
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sanitizeFolder(raw: unknown): Folder | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!id) return null
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : '未命名文件夹'
  const parentId =
    typeof raw.parentId === 'string' && raw.parentId ? raw.parentId : null
  // 区分 v3（有 items 字段）与 v2（无 items，用 chatIds+order）
  const hasItems = Array.isArray(raw.items)
  // v3：读取混合 items 序列
  let items: FolderItem[] = []
  if (hasItems && Array.isArray(raw.items)) {
    items = raw.items
      .map((x) => {
        if (!isRecord(x)) return null
        if (x.kind === 'chat' && typeof x.id === 'string') {
          return { kind: 'chat' as const, id: x.id }
        }
        if (x.kind === 'folder' && typeof x.id === 'string') {
          return { kind: 'folder' as const, id: x.id }
        }
        return null
      })
      .filter((x): x is FolderItem => x !== null)
  }
  // v2 旧字段：chatIds（对话）与 order 保留，供 validateState 做一次迁移
  const legacyChatIds = Array.isArray(raw.chatIds)
    ? raw.chatIds.filter((x): x is string => typeof x === 'string')
    : []
  return {
    id,
    name,
    parentId,
    collapsed: raw.collapsed === true,
    items: items.length ? [...new Set(items)] : [],
    // 仅真正的 v2 数据（无 items 字段）保留 chatIds 以触发迁移；v3 空文件夹不误判
    chatIds: hasItems ? undefined : [...new Set(legacyChatIds)],
    order: hasItems ? undefined : typeof raw.order === 'number' ? raw.order : 0,
  }
}

/** 对读出的脏数据做 schema 校验与默认值兜底，防止白屏 */
export function validateState(raw: unknown): StorageSchema {
  const state = defaultState()
  if (!isRecord(raw)) return state

  if (Array.isArray(raw.folders)) {
    state.folders = raw.folders
      .map(sanitizeFolder)
      .filter((f): f is Folder => f !== null)
  }

  // 校验 parentId：必须指向存在的文件夹，且不能形成循环引用（旧数据无 parentId → 根级）
  const folderIds = new Set(state.folders.map((f) => f.id))
  for (const f of state.folders) {
    if (f.parentId && !folderIds.has(f.parentId)) {
      f.parentId = null
    }
  }
  for (const f of state.folders) {
    let cur = f.parentId
    const seen = new Set([f.id])
    while (cur) {
      if (seen.has(cur)) {
        f.parentId = null
        break
      }
      seen.add(cur)
      cur = state.folders.find((x) => x.id === cur)?.parentId ?? null
    }
  }

  // 是否有旧版（v2）文件夹：以 chatIds 存在为标志，需要做一次迁移
  const hasLegacy = state.folders.some((f) => f.chatIds !== undefined)

  if (isRecord(raw.chatFolderMap)) {
    const folderIdSet = new Set(state.folders.map((f) => f.id))
    for (const [chatId, folderId] of Object.entries(raw.chatFolderMap)) {
      if (typeof folderId === 'string' && folderIdSet.has(folderId)) {
        state.chatFolderMap[chatId] = folderId
      }
    }
  }

  if (hasLegacy) {
    // v2 → v3 迁移：把每个文件夹的 chatIds 与子文件夹（parentId 关联）合并为 items。
    // 子文件夹按 order 在前、对话按 chatIds 顺序在后（还原旧版渲染顺序）。
    for (const folder of state.folders) {
      const children = state.folders
        .filter((f) => (f.parentId ?? null) === folder.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      const chatIds = (folder.chatIds ?? []).filter(
        (cid) => state.chatFolderMap[cid] === folder.id,
      )
      folder.items = [
        ...children.map((c) => ({ kind: 'folder' as const, id: c.id })),
        ...chatIds.map((cid) => ({ kind: 'chat' as const, id: cid })),
      ]
    }
    // 清理迁移后的临时字段
    for (const folder of state.folders) {
      delete folder.chatIds
      delete folder.order
    }
  } else {
    // v3 原生数据：items 为权威序列，清理指向不存在条目的引用
    const folderIdSet = new Set(state.folders.map((f) => f.id))
    for (const folder of state.folders) {
      folder.items = folder.items.filter((it) => {
        if (it.kind === 'chat') {
          return state.chatFolderMap[it.id] === folder.id
        }
        return folderIdSet.has(it.id)
      })
    }
    // 映射指向该文件夹但不在 items 中的对话，补到末尾
    for (const folder of state.folders) {
      const known = new Set(
        folder.items
          .filter((it) => it.kind === 'chat')
          .map((it) => it.id),
      )
      for (const [chatId, folderId] of Object.entries(state.chatFolderMap)) {
        if (folderId === folder.id && !known.has(chatId)) {
          folder.items.push({ kind: 'chat', id: chatId })
          known.add(chatId)
        }
      }
    }
  }

  if (Array.isArray(raw.uncategorizedIds)) {
    const inMap = new Set(Object.keys(state.chatFolderMap))
    state.uncategorizedIds = [
      ...new Set(
        raw.uncategorizedIds.filter(
          (x): x is string => typeof x === 'string' && !inMap.has(x),
        ),
      ),
    ]
  }

  // 根级文件夹顺序 rootItems
  const rootFolderSet = new Set(
    state.folders
      .filter((f) => (f.parentId ?? null) === null)
      .map((f) => f.id),
  )
  if (Array.isArray(raw.rootItems)) {
    state.rootItems = raw.rootItems
      .filter(
        (x): x is FolderItem =>
          isRecord(x) && x.kind === 'folder' && rootFolderSet.has(x.id as string),
      )
      .map((x) => ({ kind: 'folder' as const, id: x.id }))
  } else {
    state.rootItems = []
  }
  // 补齐：存在于根级但未列入 rootItems 的文件夹，追加到末尾
  const listed = new Set(state.rootItems.map((it) => it.id))
  for (const fid of rootFolderSet) {
    if (!listed.has(fid)) {
      state.rootItems.push({ kind: 'folder', id: fid })
      listed.add(fid)
    }
  }

  // 整理：确保每个文件夹都有 items 数组
  for (const folder of state.folders) {
    if (!Array.isArray(folder.items)) folder.items = []
  }

  return state
}

const hasChromeStorage =
  typeof chrome !== 'undefined' && !!chrome.storage?.local

export async function loadState(): Promise<StorageSchema> {
  if (!hasChromeStorage) return defaultState()
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY)
    return validateState(result[STORAGE_KEY])
  } catch (err) {
    console.error(`${TAG} 读取存储失败，使用默认状态`, err)
    return defaultState()
  }
}

/** 计算状态的规范化签名，用于比对 */
export function signatureOf(state: StorageSchema): string {
  return JSON.stringify({
    folders: state.folders.map((f) => ({
      id: f.id,
      n: f.name,
      p: f.parentId,
      c: f.collapsed,
      items: f.items,
    })),
    map: state.chatFolderMap,
    u: state.uncategorizedIds,
    ri: state.rootItems,
  })
}

/** 最近一次本上下文写入的签名，用于在 onChanged 中跳过自身回声 */
let lastWrittenSignature: string | null = null

export async function saveStateNow(state: StorageSchema): Promise<void> {
  if (!hasChromeStorage) return
  try {
    // 先记录签名：onChanged 在 set 完成后同步/微任务触发时此值已就绪
    lastWrittenSignature = signatureOf(state)
    await chrome.storage.local.set({ [STORAGE_KEY]: state })
  } catch (err) {
    console.error(`${TAG} 写入存储失败`, err)
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingState: StorageSchema | null = null

/** 去抖写入，避免拖拽过程中频繁 I/O */
export function saveStateDebounced(state: StorageSchema, delay = 300): void {
  pendingState = state
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (pendingState) {
      void saveStateNow(pendingState)
      pendingState = null
    }
  }, delay)
}

/**
 * 监听存储变更。
 * 关键：chrome.storage.onChanged 会在「发起写入的同一标签页」也触发，
 * 若不跳过自身回声，会与本地的 watch→persist 形成重渲染风暴。
 */
export function onStateChanged(cb: (state: StorageSchema) => void): () => void {
  if (!hasChromeStorage) return () => {}
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'local' || !(STORAGE_KEY in changes)) return
    const newState = validateState(changes[STORAGE_KEY].newValue)
    // 跳过本上下文自身写入的回声
    if (
      lastWrittenSignature !== null &&
      signatureOf(newState) === lastWrittenSignature
    ) {
      return
    }
    cb(newState)
  }
  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}
