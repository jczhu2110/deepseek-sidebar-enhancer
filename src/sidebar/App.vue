<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import draggable from 'vuedraggable'
import { Plus } from 'lucide-vue-next'
import type { ChatSession, Folder } from '@/types'
import { useChatStore } from '@/stores/chat'
import { useFolderStore } from '@/stores/folder'
import {
  clickNativeChat,
  nativeRenameSession,
  triggerNativeAction,
} from '@/utils/native-dom'
import {
  apiRenameChat,
  apiShareChat,
  extractShareUrl,
} from '@/utils/native-api'
import {
  putChatOnly,
  putFolderOnly,
  recordDragStart,
  resetDragSession,
  isOutsideSourceFolder,
} from '@/utils/dnd'
import FolderItem from '@/sidebar/components/FolderItem.vue'
import ChatItem from '@/sidebar/components/ChatItem.vue'
import ActionMenu from '@/sidebar/components/ActionMenu.vue'
import { ICON_STROKE, ICON_SIZE_CONTENT } from '@/sidebar/icons'

const folderStore = useFolderStore()
const chatStore = useChatStore()

/* ---------- 新建文件夹 / 删除确认 ---------- */
function createFolder(): void {
  const folder = folderStore.createFolder('新建文件夹')
  folderStore.editingFolderId = folder.id
  // 标记「新建未提交」：取消/空名提交时自动回收，避免残留空壳文件夹
  folderStore.pendingNewFolderId = folder.id
}

/** 侧边栏根容器（Toast 悬浮定位使用） */
const rootRef = ref<HTMLElement | null>(null)

/* ---------- 根级文件夹列表（可拖拽排序/拖入成为子级） ---------- */
const rootFolders = computed<Folder[]>({
  get: () => folderStore.rootFolders,
  set: (list) => {
    folderStore.setRootItems(list)
  },
})

function onFolderDragStart(evt: {
  oldIndex?: number
  originalEvent?: DragEvent
}): void {
  const index = evt.oldIndex ?? -1
  const f = index >= 0 ? rootFolders.value[index] : undefined
  if (!f) return
  folderStore.draggingFolderId = f.id
  evt.originalEvent?.dataTransfer?.setData('application/x-ds-folder', f.id)
  evt.originalEvent?.dataTransfer?.setData('text/plain', f.name)
  recordDragStart(null)
}

function onFolderDragEnd(): void {
  folderStore.draggingFolderId = null
  resetDragSession()
}

/* ---------- 对话「更多」菜单 ---------- */
const actionMenu = ref<{
  chat: ChatSession
  /** 锚点（触发按钮点击坐标），定位与翻转由 ActionMenu 内部处理 */
  x: number
  y: number
  /** 触发按钮：Esc 关闭时归还焦点 */
  source: HTMLElement | null
} | null>(null)

function openActionMenu(
  chat: ChatSession,
  x: number,
  y: number,
  source?: HTMLElement | null,
): void {
  actionMenu.value = { chat, x, y, source: source ?? null }
}

function closeActionMenu(): void {
  actionMenu.value = null
}

/** 菜单内 Esc 关闭：归还焦点到触发按钮 */
function onMenuClose(): void {
  const source = actionMenu.value?.source ?? null
  actionMenu.value = null
  source?.focus()
}

/** 全局 pointerdown 关闭菜单（捕获 Shadow DOM 外部的点击） */
function onGlobalPointerDown(): void {
  closeActionMenu()
}

function onMenuAction(action: 'rename' | 'share' | 'delete'): void {
  const ctx = actionMenu.value
  if (!ctx) return
  const chatId = ctx.chat.id
  closeActionMenu()

  switch (action) {
    case 'rename':
      editingChatId.value = chatId
      break
    case 'share':
      handleShare(chatId)
      break
    case 'delete':
      void deleteViaNative(ctx.chat)
      break
  }
}

/** 删除对话：触发原生删除按钮，弹出 DeepSeek 原生确认框并由其完成删除
 *  （拦截器捕获删除接口后回传 session-deleted，本地列表自动同步；
 *  拦截器失效时由 content 层的 DOM 对账兜底移除）。
 *  原生入口为唯一路径，不设自绘降级；定位失败仅提示 */
async function deleteViaNative(chat: ChatSession): Promise<void> {
  const ok = await triggerNativeAction(chat.id, 'delete')
  if (!ok) {
    showToast('未找到原生删除入口，请重试')
    return
  }
  // 携带目标 id 开启监听窗口：原生行被 React 移除的瞬间即同步侧边栏
  window.dispatchEvent(
    new CustomEvent('dsf-extract-now', { detail: { watchId: chat.id } }),
  )
}

/** 分享：真实调用网页端生成分享链接并复制 */
async function handleShare(chatId: string): Promise<void> {
  showToast('正在生成分享链接…')
  const res = await apiShareChat(chatId)
  if (res.ok) {
    const url = extractShareUrl(res.data, chatId)
    if (url) {
      try {
        await navigator.clipboard.writeText(url)
        showToast('分享链接已复制')
      } catch {
        showToast(`分享链接：${url}`)
      }
    } else {
      showToast('分享成功')
    }
  } else {
    // 分享接口不可用时，打开对话引导手动分享
    openChat(chatId)
    showToast('未找到分享入口，已打开对话')
  }
}

/* ---------- 对话行内重命名（原位置编辑，不弹窗；联动原生重命名流程） ---------- */
const editingChatId = ref<string | null>(null)
/** 重命名请求在途的会话 id（行内输入框置 pending 态：禁用 + spinner） */
const renamePendingId = ref<string | null>(null)

async function onChatRename(payload: { id: string; title: string }): Promise<void> {
  renamePendingId.value = payload.id
  try {
    // 优先调用网页端真实重命名接口
    const res = await apiRenameChat(payload.id, payload.title)
    if (res.ok) {
      chatStore.renameSession(payload.id, payload.title)
      showToast('重命名成功')
      editingChatId.value = null
      return
    }
    // 接口不可用时降级为原生 DOM 编辑流程
    const ok = await nativeRenameSession(payload.id, payload.title)
    if (ok) {
      chatStore.renameSession(payload.id, payload.title)
      showToast('重命名成功')
      editingChatId.value = null
      return
    }
    // 两条路径都失败：保留编辑态与草稿可重试，不静默本地改名
    showToast('重命名失败，请稍后重试')
  } finally {
    renamePendingId.value = null
  }
}

/* ---------- 轻量提示 ---------- */
const toastMsg = ref<string | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(msg: string): void {
  toastMsg.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMsg.value = null
  }, 2400)
}

/** Toast 水平定位：侧边栏区域底部居中（而非整页底部中央，避免脱离侧边栏语境） */
function sidebarCenterX(): number {
  const rect = rootRef.value?.getBoundingClientRect()
  return rect ? rect.left + rect.width / 2 : window.innerWidth / 2
}

/* ---------- 根级文件夹区域作为对话放置目标：放入即归入未分类 ---------- */
/* 按需求移除根区域拖拽视觉反馈（高亮/文案切换），仅保留放置功能本身；
 * 拖拽悬停的高亮反馈只保留文件夹头部一处（FolderItem 内维护） */
const rootDropAreaRef = ref<HTMLElement | null>(null)

function onRootAreaDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('application/x-ds-chat')) return
  // 拖拽目标在某个文件夹内部（含展开的内容区/列表）时交由该文件夹处理，不接管
  if ((event.target as Element | null)?.closest?.('[data-dsf-kind="folder"]')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
}

function onRootAreaDrop(event: DragEvent): void {
  // 拖拽目标在某个文件夹内部（含展开的内容区/列表）时交由该文件夹处理，
  // 不得在此归未分类（否则会抢在 Sortable 之前拦截，对话无法移入目标文件夹）
  if ((event.target as Element | null)?.closest?.('[data-dsf-kind="folder"]')) {
    folderStore.draggingChatId = null
    return
  }
  // 对话只有完全移出源文件夹边界后才允许归未分类；否则视为误触，回滚原位
  if (!isOutsideSourceFolder(event)) {
    folderStore.draggingChatId = null
    return
  }
  const chatId = event.dataTransfer?.getData('application/x-ds-chat')
  if (!chatId) return
  event.preventDefault()
  event.stopPropagation()
  folderStore.moveChatToUncategorized(chatId)
  folderStore.draggingChatId = null
}

/* ---------- 未分类会话列表 ---------- */
const uncategorizedChats = computed<ChatSession[]>({
  get: () =>
    folderStore.uncategorizedIds
      .map((id) => chatStore.byId(id))
      .filter((s): s is ChatSession => !!s),
  set: (list) => {
    folderStore.setUncategorized(list.map((c) => c.id))
  },
})

function onChatDragStart(evt: {
  oldIndex?: number
  originalEvent?: DragEvent
}): void {
  closeActionMenu()
  const index = evt.oldIndex ?? -1
  const chat = index >= 0 ? uncategorizedChats.value[index] : undefined
  folderStore.draggingChatId = chat?.id ?? null
  recordDragStart(null)
}

function onChatDragEnd(): void {
  folderStore.draggingChatId = null
  resetDragSession()
}

/* ---------- 点击打开会话（原生路由跳转） ---------- */
const CHAT_PATH_RE = /\/a\/chat\/s\/([\w-]+)/
const activeChatId = ref<string | null>(null)

function refreshActiveChat(): void {
  const match = window.location.pathname.match(CHAT_PATH_RE)
  activeChatId.value = match ? match[1] : null
}

function openChat(id: string): void {
  activeChatId.value = id
  if (!clickNativeChat(id)) {
    // 原生节点缺失时降级为直接跳转
    window.location.assign(`/a/chat/s/${id}`)
  }
}

let activeTimer: ReturnType<typeof setInterval> | null = null

function onWindowDragEnd(): void {
  folderStore.draggingChatId = null
  folderStore.draggingFolderId = null
  resetDragSession()
}

onMounted(() => {
  refreshActiveChat()
  // MAIN world 已补丁 pushState/replaceState 并经桥转发 dsf-location-changed，
  // 高亮零延迟跟随；低频轮询仅作桥消息丢失时的兜底
  activeTimer = setInterval(refreshActiveChat, 3000)
  window.addEventListener('popstate', refreshActiveChat)
  window.addEventListener('dsf-location-changed', refreshActiveChat)
  window.addEventListener('dragend', onWindowDragEnd)
  // 全局监听：点击外部关闭更多菜单（Shadow DOM 外部的点击不会冒泡到根 div）
  window.addEventListener('pointerdown', onGlobalPointerDown)
})

onBeforeUnmount(() => {
  if (activeTimer) clearInterval(activeTimer)
  window.removeEventListener('popstate', refreshActiveChat)
  window.removeEventListener('dsf-location-changed', refreshActiveChat)
  window.removeEventListener('dragend', onWindowDragEnd)
  window.removeEventListener('pointerdown', onGlobalPointerDown)
})
</script>

<template>
  <div
    ref="rootRef"
    class="dsf-scroll flex w-full flex-col gap-1 px-2 pb-8"
    @click="closeActionMenu"
  >
    <!-- 新建文件夹（幽灵操作行） -->
    <button
      type="button"
      class="dsf-row group mb-1 cursor-pointer border-0 bg-transparent text-subheading text-[var(--dsf-text-dim)] hover:bg-[var(--dsf-hover)] hover:text-[var(--dsf-text)]"
      @click="createFolder"
    >
      <Plus
        class="dsf-icon dsf-icon--group-hover-text"
        :class="ICON_SIZE_CONTENT"
        :stroke-width="ICON_STROKE"
      />
      新建文件夹
    </button>

    <!-- 根级文件夹（可拖拽排序 / 拖出成为子级 / 拖入成为根级；对话拖入归入未分类） -->
    <div
      ref="rootDropAreaRef"
      class="flex flex-col gap-1 rounded-ds"
      @dragover="onRootAreaDragOver"
      @drop="onRootAreaDrop"
    >
      <draggable
        v-model="rootFolders"
        item-key="id"
        :group="{ name: 'folders', pull: true, put: putFolderOnly }"
        handle=".dsf-folder-handle"
        filter=".dsf-no-drag"
        :prevent-on-filter="false"
        :animation="180"
        ghost-class="dsf-ghost"
        chosen-class="dsf-chosen"
        class="flex min-h-[24px] flex-col gap-0.5"
        @start="onFolderDragStart"
        @end="onFolderDragEnd"
      >
        <template #item="{ element }">
          <FolderItem
            :folder="element"
            :active-chat-id="activeChatId"
            :editing-chat-id="editingChatId"
            :rename-pending-id="renamePendingId"
            @request-delete="folderStore.deleteFolder($event.id)"
            @open-chat="openChat"
            @more="openActionMenu($event.chat, $event.x, $event.y, $event.source)"
            @rename="onChatRename"
            @cancel-rename="editingChatId = null"
          />
        </template>
      </draggable>
    </div>

    <!-- 未分类对话（纯文字分节标题：宽字距 + 大留白） -->
    <div class="mb-1 mt-4 flex items-baseline gap-2 px-2.5">
      <span class="flex-1 text-micro tracking-label text-[var(--dsf-text-faint)]">
        未分类对话
      </span>
      <span class="text-micro tabular-nums text-[var(--dsf-text-faint)]">
        {{ uncategorizedChats.length }}
      </span>
    </div>

    <draggable
      v-model="uncategorizedChats"
      item-key="id"
      :group="{ name: 'chats', pull: true, put: putChatOnly }"
      filter=".dsf-no-drag"
      :prevent-on-filter="false"
      :animation="180"
      class="flex min-h-[28px] flex-col gap-0.5"
      @start="onChatDragStart"
      @end="onChatDragEnd"
    >
      <template #item="{ element }">
        <ChatItem
          :chat="element"
          :active="element.id === activeChatId"
          :editing="element.id === editingChatId"
          :pending="element.id === renamePendingId"
          @open="openChat"
          @more="openActionMenu($event.chat, $event.x, $event.y, $event.source)"
          @rename="onChatRename"
          @cancel-rename="editingChatId = null"
        />
      </template>
      <template #footer>
        <div
          v-if="!uncategorizedChats.length"
          class="px-2.5 py-3 text-center text-caption text-[var(--dsf-text-faint)]"
        >
          所有对话都已分类
        </div>
      </template>
    </draggable>

    <!-- 对话更多菜单 -->
    <ActionMenu
      v-if="actionMenu"
      :chat="actionMenu.chat"
      :x="actionMenu.x"
      :y="actionMenu.y"
      @action="onMenuAction"
      @close="onMenuClose"
    />

    <!-- 轻量提示（毛玻璃胶囊，侧边栏区域底部居中） -->
    <Transition name="dsf-fade">
      <div
        v-if="toastMsg"
        role="status"
        class="pointer-events-none fixed bottom-6 z-toast -translate-x-1/2 rounded-full bg-[var(--dsf-surface-raised)] px-4 py-2 text-caption text-[var(--dsf-text)] shadow-[var(--dsf-shadow-pop)] backdrop-blur-[12px]"
        :style="{ left: `${sidebarCenterX()}px` }"
      >
        {{ toastMsg }}
      </div>
    </Transition>
  </div>
</template>
