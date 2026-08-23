/**
 * 调试日志开关：默认完全静默，扩展正常运行时不产生任何控制台输出。
 * 排障时在 DevTools Console 执行：
 *   localStorage.setItem('dsf-debug', '1')
 * 并刷新页面开启；localStorage.removeItem('dsf-debug') 后刷新恢复静默。
 */
let enabled: boolean | null = null

function isEnabled(): boolean {
  if (enabled === null) {
    try {
      enabled = localStorage.getItem('dsf-debug') === '1'
    } catch {
      enabled = false
    }
  }
  return enabled
}

/** 调试信息日志（默认静默） */
export function debugLog(...args: unknown[]): void {
  if (isEnabled()) console.info(...args)
}

/** 调试告警日志（默认静默）：用于原生 DOM 失配等可降级路径的诊断 */
export function debugWarn(...args: unknown[]): void {
  if (isEnabled()) console.warn(...args)
}
