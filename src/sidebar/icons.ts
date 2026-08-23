/**
 * 图标系统规范 —— 与 docs/UI-DESIGN.md 配套的统一图标语言。
 *
 * - 风格：lucide 线条图标（iOS / Fluent 线性语言，24px 网格，圆角端点）
 * - 描边：统一 ICON_STROKE（viewBox 单位），随渲染尺寸等比缩放，视觉粗细一致
 * - 尺寸：两档 —— ICON_SIZE_CONTENT 内容行图标 / ICON_SIZE_ACTION 行内操作图标
 * - 颜色：禁止组件内散落硬编码，统一挂 .dsf-icon + 语义/状态修饰类（见 main.css）
 * - 状态：默认 / 选中(--selected) / 禁用(--disabled) 由修饰类表达；
 *   悬停/按下态由 .dsf-icon-btn 图标按钮内建（图标色随按钮状态继承）
 */

/** 统一描边粗细（lucide viewBox 24 单位；14px 渲染 ≈ 1.17px，16px ≈ 1.33px） */
export const ICON_STROKE = 2 as const

/** 内容行图标（文件夹 / 对话 / 折叠箭头）——16px，与 13px 正文层级匹配 */
export const ICON_SIZE_CONTENT = 'h-4 w-4' as const

/** 行内操作图标（重命名 / 删除 / 分享 / 更多）——14px，嵌于 22px 图标按钮内 */
export const ICON_SIZE_ACTION = 'h-3.5 w-3.5' as const
