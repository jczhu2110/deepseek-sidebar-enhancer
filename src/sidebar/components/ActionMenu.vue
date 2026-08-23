<script lang="ts">
/** 菜单宽度（px）：定位钳制与面板宽度共用，勿在别处复制 */
export const ACTION_MENU_WIDTH = 144
</script>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Pencil, Share2, Trash2 } from 'lucide-vue-next'
import type { ChatSession } from '@/types'
import { ICON_STROKE, ICON_SIZE_ACTION } from '@/sidebar/icons'

const props = defineProps<{
  chat: ChatSession
  /** 锚点：触发按钮的点击坐标（视口系），定位/钳制/翻转在组件内处理 */
  x: number
  y: number
}>()

const emit = defineEmits<{
  (e: 'action', action: 'rename' | 'share' | 'delete'): void
  (e: 'close'): void
}>()

const items = [
  { key: 'rename' as const, label: '重命名', icon: Pencil, danger: false },
  { key: 'share' as const, label: '分享', icon: Share2, danger: false },
  { key: 'delete' as const, label: '删除', icon: Trash2, danger: true },
]

/* ---------- 定位：水平钳制 + 底部空间不足时向上翻转（高度实测） ---------- */
const rootRef = ref<HTMLElement | null>(null)
const pos = ref({ left: props.x, top: props.y + 10 })

onMounted(() => {
  const height = rootRef.value?.offsetHeight ?? 0
  const left = Math.max(
    8,
    Math.min(props.x, window.innerWidth - ACTION_MENU_WIDTH - 12),
  )
  let top = props.y + 10
  if (height && top + height > window.innerHeight - 8) {
    top = Math.max(8, props.y - height - 10)
  }
  pos.value = { left, top }
  focusItem(0)
})

/* ---------- 键盘导航：↑/↓ 循环、Esc 关闭、Tab 圈定在菜单内 ---------- */
const itemEls = ref<HTMLElement[]>([])
/** 当前焦点项索引（Shadow DOM 内 document.activeElement 不可靠，自行跟踪） */
let focusIdx = 0

function setItemRef(el: unknown, index: number): void {
  if (el) itemEls.value[index] = el as HTMLElement
}

function focusItem(index: number): void {
  const list = itemEls.value
  if (!list.length) return
  focusIdx = ((index % list.length) + list.length) % list.length
  list[focusIdx].focus()
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusItem(focusIdx + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    focusItem(focusIdx - 1)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  } else if (event.key === 'Tab') {
    event.preventDefault()
    focusItem(focusIdx + (event.shiftKey ? -1 : 1))
  }
}
</script>

<template>
  <div
    ref="rootRef"
    class="fixed z-menu"
    role="menu"
    :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
    @click.stop
    @pointerdown.stop
    @keydown="onMenuKeydown"
  >
    <div
      class="dsf-pop rounded-pop bg-[var(--dsf-surface-raised)] p-1.5 shadow-[var(--dsf-shadow-pop)] backdrop-blur-[12px]"
      :style="{ width: `${ACTION_MENU_WIDTH}px` }"
    >
      <button
        v-for="(item, index) in items"
        :key="item.key"
        :ref="(el) => setItemRef(el, index)"
        type="button"
        role="menuitem"
        class="dsf-row cursor-pointer border-0 bg-transparent text-left text-body"
        :class="
          item.danger
            ? 'mt-1.5 text-[var(--dsf-danger)] hover:bg-[var(--dsf-danger-soft)]'
            : 'text-[var(--dsf-text)] hover:bg-[var(--dsf-hover)]'
        "
        @focus="focusIdx = index"
        @click="emit('action', item.key)"
      >
        <component
          :is="item.icon"
          class="dsf-icon"
          :class="[
            ICON_SIZE_ACTION,
            item.danger ? 'dsf-icon--danger' : 'dsf-icon--soft',
          ]"
          :stroke-width="ICON_STROKE"
        />
        {{ item.label }}
      </button>
    </div>
  </div>
</template>
