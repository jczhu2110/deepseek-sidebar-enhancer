<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Loader2, MessageSquare, MoreHorizontal } from 'lucide-vue-next'
import type { ChatSession } from '@/types'
import { useFolderStore } from '@/stores/folder'
import {
  ICON_STROKE,
  ICON_SIZE_CONTENT,
  ICON_SIZE_ACTION,
} from '@/sidebar/icons'

const props = defineProps<{
  chat: ChatSession
  active: boolean
  editing?: boolean
  /** 重命名请求在途：输入框禁用 + spinner */
  pending?: boolean
}>()

const emit = defineEmits<{
  (e: 'open', id: string): void
  (
    e: 'more',
    payload: {
      chat: ChatSession
      x: number
      y: number
      /** 触发按钮：菜单 Esc 关闭时归还焦点 */
      source: HTMLElement | null
    },
  ): void
  (e: 'rename', payload: { id: string; title: string }): void
  (e: 'cancel-rename'): void
}>()

const folderStore = useFolderStore()

/* ---------- 行内重命名（输入框出现在原标题位置） ---------- */
const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
/** 提交守卫：Enter 提交后失焦不再重复提交（重命名走 API，需防重复调用） */
let committed = false

watch(
  () => props.editing,
  async (ed) => {
    if (!ed) return
    committed = false
    draft.value = props.chat.title
    await nextTick()
    inputRef.value?.focus()
    inputRef.value?.select()
  },
  { immediate: true },
)

// 请求失败回到编辑态时重置提交守卫，允许修改后再次提交
watch(
  () => props.pending,
  (pending, prev) => {
    if (prev && !pending && props.editing) committed = false
  },
)

function commitRename(): void {
  if (committed) return
  committed = true
  const value = draft.value.trim()
  if (value && value !== props.chat.title) {
    emit('rename', { id: props.chat.id, title: value })
  } else {
    emit('cancel-rename')
  }
}

function cancelRename(): void {
  if (committed) return
  committed = true
  emit('cancel-rename')
}

/** 行键盘激活（Enter / Space），编辑态交由输入框处理 */
function onRowKeydown(event: KeyboardEvent): void {
  if (props.editing) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    emit('open', props.chat.id)
  }
}

function onDragStart(event: DragEvent): void {
  if (event.dataTransfer) {
    event.dataTransfer.setData('application/x-ds-chat', props.chat.id)
    event.dataTransfer.effectAllowed = 'move'
  }
  folderStore.draggingChatId = props.chat.id
}

function onDragEnd(): void {
  folderStore.draggingChatId = null
}

function onMoreClick(event: MouseEvent): void {
  emit('more', {
    chat: props.chat,
    x: event.clientX,
    y: event.clientY,
    source: event.currentTarget as HTMLElement | null,
  })
}
</script>

<template>
  <div
    data-dsf-kind="chat"
    role="button"
    :tabindex="editing ? -1 : 0"
    :aria-current="active ? 'true' : undefined"
    class="dsf-row group relative cursor-pointer text-body min-h-[28px] py-[3px]"
    :class="
      active
        ? 'bg-[var(--dsf-active)] text-[var(--dsf-text)]'
        : 'text-[var(--dsf-text)] hover:bg-[var(--dsf-hover)]'
    "
    :title="chat.title"
    @click="emit('open', chat.id)"
    @keydown="onRowKeydown"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
  >
    <MessageSquare
      class="dsf-icon"
      :class="[
        ICON_SIZE_CONTENT,
        active ? '' : 'dsf-icon--faint dsf-icon--group-hover',
      ]"
      :stroke-width="ICON_STROKE"
    />

    <!-- 编辑态：输入框占据原标题位置（不弹窗）；提交期间禁用 + spinner -->
    <div v-if="editing" class="relative min-w-0 flex-1">
      <input
        ref="inputRef"
        v-model="draft"
        type="text"
        class="dsf-input dsf-input--sm dsf-no-drag min-w-0 flex-1 cursor-text"
        maxlength="100"
        :disabled="pending"
        @click.stop
        @dragstart.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
      <Loader2
        v-if="pending"
        class="dsf-icon dsf-icon--faint pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 animate-spin"
        :class="ICON_SIZE_ACTION"
        :stroke-width="ICON_STROKE"
      />
    </div>
    <template v-else>
      <span class="min-w-0 flex-1 truncate select-none">{{ chat.title }}</span>

      <!-- 更多操作按钮（hover / 键盘聚焦显现） -->
      <button
        type="button"
        draggable="false"
        aria-haspopup="menu"
        class="dsf-icon-btn opacity-0 transition-all duration-fast group-hover:opacity-100 group-focus-within:opacity-100"
        :class="{ 'dsf-icon-btn--inset': active }"
        title="更多操作"
        @click.stop="onMoreClick"
      >
        <MoreHorizontal
          class="dsf-icon"
          :class="ICON_SIZE_ACTION"
          :stroke-width="ICON_STROKE"
        />
      </button>
    </template>
  </div>
</template>
