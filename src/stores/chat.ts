import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ChatSession } from '@/types'
import { useFolderStore } from '@/stores/folder'

export const useChatStore = defineStore('chat', () => {
  const sessionsById = ref<Record<string, ChatSession>>({})
  /** 全部已知会话 id（保持最近一次接口/DOM 提供的相对顺序） */
  const sessionOrder = ref<string[]>([])

  const allSessions = computed<ChatSession[]>(() =>
    sessionOrder.value
      .map((id) => sessionsById.value[id])
      .filter((s): s is ChatSession => !!s),
  )

  function byId(id: string): ChatSession | undefined {
    return sessionsById.value[id]
  }

  /** 最近一次合并的会话签名，用于跳过重复数据，避免 syncSessions 无意义触发 */
  let lastIncomingSig = ''

  /** 合并一批会话（接口拦截或 DOM 兜底提取） */
  function upsertSessions(incoming: ChatSession[]): void {
    // 签名按 id:title 排序，与顺序无关：重复的 fetch_page/DOM 提取直接跳过
    const sig = incoming
      .map((s) => `${s.id}\u0001${s.title ?? ''}`)
      .sort()
      .join('\n')
    if (sig === lastIncomingSig) return
    lastIncomingSig = sig

    const folderStore = useFolderStore()
    const seen = new Set<string>()

    for (const raw of incoming) {
      if (!raw || typeof raw.id !== 'string' || !raw.id) continue
      const id = raw.id
      if (seen.has(id)) continue
      seen.add(id)
      const title = (raw.title ?? '').trim() || '未命名对话'
      const existing = sessionsById.value[id]
      if (existing) {
        if (existing.title !== title) {
          existing.title = title
        }
      } else {
        sessionsById.value[id] = { id, title, updatedAt: raw.updatedAt }
      }
    }

    // 将新出现的 id 按传入顺序并入全局顺序（保留既有相对位置）
    const incomingIds = incoming
      .map((s) => s?.id)
      .filter((x): x is string => typeof x === 'string' && !!x)
    const incomingSet = new Set(incomingIds)
    const merged: string[] = []
    let cursor = 0
    for (const id of sessionOrder.value) {
      if (!incomingSet.has(id)) {
        merged.push(id)
      } else {
        while (cursor < incomingIds.length && !merged.includes(incomingIds[cursor])) {
          merged.push(incomingIds[cursor])
          cursor++
        }
      }
    }
    while (cursor < incomingIds.length) {
      if (!merged.includes(incomingIds[cursor])) merged.push(incomingIds[cursor])
      cursor++
    }
    sessionOrder.value = merged

    folderStore.syncSessions(sessionOrder.value)
  }

  function renameSession(id: string, title: string): void {
    const session = sessionsById.value[id]
    const trimmed = title.trim()
    if (!session || !trimmed || session.title === trimmed) return
    session.title = trimmed
  }

  function removeSession(id: string): void {
    if (!sessionsById.value[id]) return
    delete sessionsById.value[id]
    const i = sessionOrder.value.indexOf(id)
    if (i !== -1) sessionOrder.value.splice(i, 1)
    useFolderStore().pruneSession(id)
  }

  return {
    sessionsById,
    sessionOrder,
    allSessions,
    byId,
    upsertSessions,
    renameSession,
    removeSession,
  }
})
