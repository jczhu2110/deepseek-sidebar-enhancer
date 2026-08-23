<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import draggable from 'vuedraggable'
import {
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-vue-next'
import type { ChatSession, Folder } from '@/types'
import { useChatStore } from '@/stores/chat'
import { useFolderStore } from '@/stores/folder'
import {
  ICON_STROKE,
  ICON_SIZE_CONTENT,
  ICON_SIZE_ACTION,
} from '@/sidebar/icons'
import {
  putMixed,
  recordDragStart,
  resetDragSession,
  isOutsideSourceFolder,
  getSourceFolderId,
} from '@/utils/dnd'
import ChatItem from './ChatItem.vue'
// 递归渲染子文件夹（Vue 3 支持组件自引用）
import FolderItem from './FolderItem.vue'

const props = defineProps<{
  folder: Folder
  activeChatId: string | null
  editingChatId: string | null
  renamePendingId: string | null
}>()

const emit = defineEmits<{
  (e: 'request-delete', folder: Folder): void
  (e: 'open-chat', id: string): void
  (
    e: 'more',
    payload: {
      chat: ChatSession
      x: number
      y: number
      source: HTMLElement | null
    },
  ): void
  (e: 'rename', payload: { id: string; title: string }): void
  (e: 'cancel-rename'): void
}>()

const chatStore = useChatStore()
const folderStore = useFolderStore()

/** 当前文件夹根元素（作为拖拽的「源文件夹边界」） */
const rootEl = ref<HTMLElement | null>(null)

/** 数量徽标：子树内全部对话数（含子级文件夹中的对话，不含子级文件夹本身） */
const subtreeChatCount = computed(
  () => folderStore.countFolderTree(props.folder.id).chatCount,
)

/* ---------- 行内重命名 ---------- */
const editing = computed(() => folderStore.editingFolderId === props.folder.id)
const draftName = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

watch(
  () => editing.value,
  async (ed) => {
    if (!ed) return
    draftName.value = props.folder.name
    await nextTick()
    inputRef.value?.focus()
    inputRef.value?.select()
  },
  { immediate: true },
)

function commitRename(): void {
  const value = draftName.value.trim()
  const isNew = folderStore.pendingNewFolderId === props.folder.id
  if (isNew && !value) {
    // 新建未命名即提交：回收空壳文件夹
    folderStore.deleteFolder(props.folder.id)
  } else if (value && value !== props.folder.name) {
    folderStore.renameFolder(props.folder.id, value)
  }
  if (isNew) folderStore.pendingNewFolderId = null
  folderStore.editingFolderId = null
}

function cancelRename(): void {
  // 新建后直接取消：回收空壳文件夹
  if (folderStore.pendingNewFolderId === props.folder.id) {
    folderStore.deleteFolder(props.folder.id)
    folderStore.pendingNewFolderId = null
  }
  folderStore.editingFolderId = null
}

function createChildFolder(): void {
  const child = folderStore.createFolder('新建文件夹', props.folder.id)
  folderStore.editingFolderId = child.id
  folderStore.pendingNewFolderId = child.id
}

/* ---------- 行内删除确认：尾部红色确认按钮，再次点击才真正删除 ---------- */
const confirmingDelete = ref(false)
const headerEl = ref<HTMLElement | null>(null)
let confirmResetTimer: ReturnType<typeof setTimeout> | null = null
/** 确认态无操作自动退出的时长 */
const CONFIRM_RESET_MS = 4000

function startDeleteConfirm(): void {
  confirmingDelete.value = true
  if (confirmResetTimer) clearTimeout(confirmResetTimer)
  confirmResetTimer = setTimeout(() => cancelDeleteConfirm(), CONFIRM_RESET_MS)
}

function cancelDeleteConfirm(): void {
  confirmingDelete.value = false
  if (confirmResetTimer) {
    clearTimeout(confirmResetTimer)
    confirmResetTimer = null
  }
}

function confirmDeleteNow(): void {
  const folder = props.folder
  cancelDeleteConfirm()
  emit('request-delete', folder)
}

/** 点击头部以外任意处取消确认态（捕获阶段，先于其他点击逻辑）。
 *  监听挂在 document（Shadow DOM 外）：事件穿出 shadow 边界时 target 会被
 *  重定向为宿主元素，contains 判断必然失败（曾导致点击确认按钮被误取消、
 *  按钮在 click 前被移除而删除失效），必须用 composedPath 取真实路径判断。 */
function onDocPointerDown(event: PointerEvent): void {
  if (!confirmingDelete.value) return
  const header = headerEl.value
  if (header && event.composedPath().includes(header)) return
  cancelDeleteConfirm()
}

watch(confirmingDelete, (on) => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  if (on) document.addEventListener('pointerdown', onDocPointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  if (confirmResetTimer) clearTimeout(confirmResetTimer)
})

/** 头部点击：确认态下点击行内（非按钮）区域取消确认；常态切换折叠。
 *  鼠标点击后头部保持聚焦会让 group-focus-within 令操作按钮持续可见，
 *  点击完成后主动归还焦点，按钮随鼠标离开隐藏；
 *  键盘路径（Enter/Space）走 onHeaderKeydown 不触发 click，聚焦保留不受影响。 */
function onHeaderClick(event: MouseEvent): void {
  ;(event.currentTarget as HTMLElement | null)?.blur()
  if (confirmingDelete.value) {
    cancelDeleteConfirm()
    return
  }
  folderStore.toggleCollapsed(props.folder.id)
}

/** 头部键盘激活（Enter / Space 折叠切换），编辑态交由输入框处理 */
function onHeaderKeydown(event: KeyboardEvent): void {
  if (editing.value) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    folderStore.toggleCollapsed(props.folder.id)
  }
}

/* ---------- 混排条目：子文件夹 + 对话在同一序列内自由排序 ---------- */
type MixedNode =
  | { kind: 'folder'; folder: Folder }
  | { kind: 'chat'; chat: ChatSession }

const mixedItems = computed<MixedNode[]>({
  get: () => {
    const result: MixedNode[] = []
    for (const it of props.folder.items) {
      if (it.kind === 'folder') {
        const f = folderStore.folders.find((x) => x.id === it.id)
        if (f && (f.parentId ?? null) === props.folder.id) {
          result.push({ kind: 'folder', folder: f })
        }
      } else {
        const c = chatStore.byId(it.id)
        if (c) result.push({ kind: 'chat', chat: c })
      }
    }
    return result
  },
  set: (list) => {
    folderStore.setFolderItems(
      props.folder.id,
      list.map((n) => toFolderItem(n)),
    )
  },
})

/** 将 vuedraggable 传入的元素规范化为 FolderItem。
 * 跨列表拖拽时元素可能是源列表的原始对象（ChatSession / Folder），
 * 也可能是本列表的 MixedNode，需统一转换避免写入 {kind:undefined} 的坏条目。 */
function toFolderItem(n: unknown): { kind: 'folder' | 'chat'; id: string } {
  if (n && typeof n === 'object') {
    const o = n as Record<string, unknown>
    if (o.kind === 'folder' && typeof (o as { folder?: { id?: unknown } }).folder?.id === 'string') {
      return { kind: 'folder', id: (o as { folder: { id: string } }).folder.id }
    }
    if (o.kind === 'chat' && typeof (o as { chat?: { id?: unknown } }).chat?.id === 'string') {
      return { kind: 'chat', id: (o as { chat: { id: string } }).chat.id }
    }
    // 原始对象：Folder 含 items 字段，ChatSession 不含
    if (typeof o.id === 'string') {
      return { kind: 'items' in o ? 'folder' : 'chat', id: o.id }
    }
  }
  return { kind: 'chat', id: '' }
}

/** 拖拽开始时定位被拖项：folder 或 chat */
function onItemDragStart(evt: {
  oldIndex?: number
  originalEvent?: DragEvent
}): void {
  const index = evt.oldIndex ?? -1
  const node = index >= 0 ? mixedItems.value[index] : undefined
  if (!node) return
  if (node.kind === 'folder') {
    folderStore.draggingFolderId = node.folder.id
    evt.originalEvent?.dataTransfer?.setData(
      'application/x-ds-folder',
      node.folder.id,
    )
    evt.originalEvent?.dataTransfer?.setData('text/plain', node.folder.name)
    recordDragStart(null)
  } else {
    folderStore.draggingChatId = node.chat.id
    recordDragStart(rootEl.value, props.folder.id)
  }
}

function onItemDragEnd(): void {
  folderStore.draggingFolderId = null
  folderStore.draggingChatId = null
  resetDragSession()
}

/* ---------- 文件夹头部作为放置目标（folder / chat 均可） ---------- */
const isDropTarget = ref(false)
let expandTimer: ReturnType<typeof setTimeout> | null = null
/** 悬停折叠文件夹自动展开的延时 */
const HOVER_EXPAND_MS = 600

function clearExpandTimer(): void {
  if (expandTimer) {
    clearTimeout(expandTimer)
    expandTimer = null
  }
}

function onHeaderDragOver(event: DragEvent): void {
  const types = event.dataTransfer?.types ?? []
  const isFolderDrag = types.includes('application/x-ds-folder')
  const isChatDrag = types.includes('application/x-ds-chat')
  if (!isFolderDrag && !isChatDrag) return
  event.preventDefault()
  event.stopPropagation()
  event.dataTransfer!.dropEffect = 'move'
  isDropTarget.value = true
  // 悬停自动展开折叠的文件夹
  if (props.folder.collapsed && !expandTimer) {
    expandTimer = setTimeout(() => {
      folderStore.toggleCollapsed(props.folder.id)
      expandTimer = null
    }, HOVER_EXPAND_MS)
  }
}

function onHeaderDragLeave(event: DragEvent): void {
  // 进入子元素触发的 dragleave 不取消高亮，避免闪烁
  const related = event.relatedTarget as Node | null
  const current = event.currentTarget as HTMLElement | null
  if (related && current?.contains(related)) return
  isDropTarget.value = false
  clearExpandTimer()
}

function onHeaderDrop(event: DragEvent): void {
  isDropTarget.value = false
  clearExpandTimer()

  const dt = event.dataTransfer
  const folderId = dt?.getData('application/x-ds-folder')
  const chatId = dt?.getData('application/x-ds-chat')

  if (folderId) {
    // 文件夹拖拽不受「完全移出」限制：嵌套拖拽的目标可能在源文件夹内部
    event.preventDefault()
    event.stopPropagation()
    folderStore.moveFolderAsChild(folderId, props.folder.id)
    folderStore.draggingFolderId = null
  } else if (chatId) {
    // 仅「拖回自身文件夹」需要误触防护：若指针未移出源边界则放弃（回滚原位）。
    if (
      getSourceFolderId() === props.folder.id &&
      !isOutsideSourceFolder(event)
    ) {
      folderStore.draggingChatId = null
      return
    }
    event.preventDefault()
    event.stopPropagation()
    folderStore.moveChatToFolder(chatId, props.folder.id)
    folderStore.draggingChatId = null
  } else {
    return
  }
  if (props.folder.collapsed) folderStore.toggleCollapsed(props.folder.id)
}

/** 拖拽终点兜底：dragleave 在取消拖拽（Esc）/ 元素重排时不一定触发，
 *  dragend 必然触发，统一在此清除放置高亮与悬停自动展开计时，避免样式残留 */
function onWinDragEnd(): void {
  isDropTarget.value = false
  clearExpandTimer()
}

onMounted(() => window.addEventListener('dragend', onWinDragEnd))
onBeforeUnmount(() => window.removeEventListener('dragend', onWinDragEnd))
</script>

<template>
  <section ref="rootEl" data-dsf-kind="folder" class="dsf-enter select-none">
    <!-- 文件夹头部（拖拽排序手柄 + 放置目标） -->
    <div
      ref="headerEl"
      role="button"
      :tabindex="editing ? -1 : 0"
      :aria-expanded="!folder.collapsed"
      class="dsf-folder-handle dsf-row group relative cursor-pointer hover:bg-[var(--dsf-hover)]"
      :class="{
        'dsf-drop-active': isDropTarget,
        'bg-[var(--dsf-danger-soft)] hover:bg-[var(--dsf-danger-soft)]': confirmingDelete,
      }"
      @click="onHeaderClick"
      @keydown="onHeaderKeydown"
      @dragover="onHeaderDragOver"
      @dragleave="onHeaderDragLeave"
      @drop="onHeaderDrop"
    >
      <ChevronRight
        class="dsf-icon dsf-icon--faint dsf-icon--group-hover"
        :class="[ICON_SIZE_CONTENT, { 'rotate-90': !folder.collapsed }]"
        :stroke-width="ICON_STROKE"
      />
      <!-- 折叠/展开图标交叉淡入（与 chevron 旋转同节奏，120ms opacity） -->
      <span class="relative shrink-0" :class="ICON_SIZE_CONTENT" aria-hidden="true">
        <FolderIcon
          class="dsf-icon absolute inset-0"
          :class="[ICON_SIZE_CONTENT, { 'opacity-0': !folder.collapsed }]"
          :stroke-width="ICON_STROKE"
        />
        <FolderOpen
          class="dsf-icon absolute inset-0"
          :class="[ICON_SIZE_CONTENT, { 'opacity-0': folder.collapsed }]"
          :stroke-width="ICON_STROKE"
        />
      </span>

      <input
        v-if="editing"
        ref="inputRef"
        v-model="draftName"
        type="text"
        class="dsf-input dsf-input--sm dsf-no-drag min-w-0 flex-1 cursor-text"
        maxlength="50"
        @click.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
      <template v-else>
        <span
          class="min-w-0 flex-1 truncate text-subheading text-[var(--dsf-text)]"
          :title="folder.name"
        >
          {{ folder.name }}
        </span>
        <!-- 删除确认态：尾部红色确认按钮，再次点击才真正删除 -->
        <button
          v-if="confirmingDelete"
          type="button"
          draggable="false"
          class="dsf-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-btn border-0 bg-[var(--dsf-danger-soft)] px-2 py-[3px] text-micro font-medium text-[var(--dsf-danger)] transition-all duration-fast hover:bg-[var(--dsf-danger)] hover:text-white active:scale-95"
          title="再次点击确认删除（点击其他区域取消）"
          @click.stop="confirmDeleteNow"
        >
          <Trash2
            class="h-3.5 w-3.5 shrink-0"
            :stroke-width="ICON_STROKE"
          />
          确认删除
        </button>
        <span
          v-else
          class="shrink-0 rounded-full px-1.5 py-px text-micro leading-[16px] text-[var(--dsf-text-faint)] transition-opacity duration-fast group-hover:opacity-0"
          :title="`含子级文件夹共 ${subtreeChatCount} 个对话`"
        >
          {{ subtreeChatCount }}
        </span>
      </template>

      <!-- hover / 键盘聚焦显现的操作按钮（确认删除态下隐藏；底色为 hover 等效实色，融合行底） -->
      <div
        v-if="!editing && !confirmingDelete"
        class="dsf-no-drag absolute right-2 flex items-center gap-0.5 rounded-full bg-[var(--dsf-hover-solid)] p-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <button
          type="button"
          class="dsf-icon-btn"
          title="重命名文件夹"
          @click.stop="folderStore.editingFolderId = folder.id"
        >
          <Pencil class="dsf-icon" :class="ICON_SIZE_ACTION" :stroke-width="ICON_STROKE" />
        </button>
        <button
          type="button"
          class="dsf-icon-btn"
          title="新建子文件夹"
          @click.stop="createChildFolder"
        >
          <FolderPlus class="dsf-icon" :class="ICON_SIZE_ACTION" :stroke-width="ICON_STROKE" />
        </button>
        <button
          type="button"
          class="dsf-icon-btn dsf-icon-btn--danger"
          title="删除文件夹（含子文件夹）"
          @click.stop="startDeleteConfirm"
        >
          <Trash2 class="dsf-icon" :class="ICON_SIZE_ACTION" :stroke-width="ICON_STROKE" />
        </button>
      </div>
    </div>

    <!-- 混排内容区：子文件夹 + 对话在同一序列内自由排序（折叠动画） -->
    <div
      class="grid"
      :style="{ gridTemplateRows: folder.collapsed ? '0fr' : '1fr' }"
      style="transition: grid-template-rows 180ms ease"
    >
      <div class="min-h-0 overflow-hidden">
        <draggable
          v-model="mixedItems"
          :item-key="(n: MixedNode) => n.kind + ':' + (n.kind === 'folder' ? n.folder.id : n.chat.id)"
          :group="{ name: 'mixed', pull: true, put: putMixed }"
          filter=".dsf-no-drag"
          :prevent-on-filter="false"
          :animation="180"
          ghost-class="dsf-ghost"
          chosen-class="dsf-chosen"
          class="ml-[18px] flex flex-col gap-0.5"
          @start="onItemDragStart"
          @end="onItemDragEnd"
        >
          <template #item="{ element }">
            <!-- vuedraggable 要求 item slot 只有一个子节点；
                 v-if/v-else 编译为单一条件节点，且比动态组件更类型安全 -->
            <FolderItem
              v-if="element.kind === 'folder'"
              :folder="element.folder"
              :active-chat-id="activeChatId"
              :editing-chat-id="editingChatId"
              :rename-pending-id="renamePendingId"
              @request-delete="emit('request-delete', $event)"
              @open-chat="emit('open-chat', $event)"
              @more="emit('more', $event)"
              @rename="emit('rename', $event)"
              @cancel-rename="emit('cancel-rename')"
            />
            <ChatItem
              v-else
              :chat="element.chat"
              :active="element.chat.id === activeChatId"
              :editing="element.chat.id === editingChatId"
              :pending="element.chat.id === renamePendingId"
              @open="emit('open-chat', $event)"
              @more="emit('more', $event)"
              @rename="emit('rename', $event)"
              @cancel-rename="emit('cancel-rename')"
            />
          </template>
        </draggable>
      </div>
    </div>
  </section>
</template>
