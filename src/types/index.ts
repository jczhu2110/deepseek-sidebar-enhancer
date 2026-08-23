/** 一条 DeepSeek 历史会话 */
export interface ChatSession {
  /** chat_id / session_id */
  id: string
  /** 会话标题 */
  title: string
  /** 最近更新时间（毫秒时间戳，可选） */
  updatedAt?: number
}

/** 文件夹内的一个条目：子文件夹或对话，数组顺序即展示/排序顺序 */
export type FolderItem =
  | { kind: 'folder'; id: string }
  | { kind: 'chat'; id: string }

/** 用户创建的文件夹 */
export interface Folder {
  id: string
  name: string
  /** 父文件夹 id；null 表示根级 */
  parentId: string | null
  /** 是否折叠（持久化） */
  collapsed: boolean
  /**
   * 文件夹内的混合条目序列：子文件夹与对话在同一序列内自由排序，
   * 数组顺序即展示顺序。条目 id 为子文件夹 id 或会话 id。
   */
  items: FolderItem[]
  /** @deprecated 旧版字段（v2），仅迁移时读取，运行时不再使用 */
  chatIds?: string[]
  /** @deprecated 旧版字段（v2），仅迁移时读取，运行时不再使用 */
  order?: number
}

/** chrome.storage.local 中持久化的完整状态 */
export interface StorageSchema {
  /** schema 版本，便于后续迁移 */
  version: number
  folders: Folder[]
  /** chatId -> folderId 映射 */
  chatFolderMap: Record<string, string>
  /** 未分类会话的展示顺序（不在任何文件夹中的会话） */
  uncategorizedIds: string[]
  /** 根级文件夹的展示/排序顺序（条目均为 kind='folder'） */
  rootItems: FolderItem[]
}

export const STORAGE_KEY = 'ds_folder_state'
export const STORAGE_VERSION = 3

/** 页面 MAIN world 与 content script 之间的桥消息来源标识 */
export const BRIDGE_SOURCE = 'ds-sidebar-enhancer'

/** 桥消息类型 */
export type BridgeMessage =
  | {
      source: typeof BRIDGE_SOURCE
      type: 'sessions'
      payload: { sessions: ChatSession[] }
    }
  | {
      source: typeof BRIDGE_SOURCE
      type: 'session-renamed'
      payload: { id: string; title: string }
    }
  | {
      source: typeof BRIDGE_SOURCE
      type: 'session-deleted'
      payload: { id: string }
    }
  | {
      source: typeof BRIDGE_SOURCE
      type: 'interceptor-ready'
    }
  | {
      source: typeof BRIDGE_SOURCE
      type: 'dsf-location-changed'
    }
  | {
      source: typeof BRIDGE_SOURCE
      type: 'dsf-token'
      payload: { token: string }
    }

export type BridgeMessageType = BridgeMessage['type']

/** 未分类分组的虚拟 id（仅 UI 使用，不入库） */
export const UNCATEGORIZED_ID = '__uncategorized__'
