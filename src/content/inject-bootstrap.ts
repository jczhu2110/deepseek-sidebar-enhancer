/**
 * ISOLATED world @ document_start：
 * 通过 <script> 标签把拦截器「同步」注入到页面 MAIN world，
 * 赶在 DeepSeek 主包快照 window.fetch 之前完成打补丁。
 *
 * 若页面 CSP 禁止内联脚本，此处静默失败，
 * 由 CRXJS 的 world:"MAIN" 入口（inpage.ts）异步兜底。
 * 两侧均带 __dsfInterceptorInstalled 守卫，重复注入安全。
 */
import { installInterceptor } from '@/inject/interceptor'

const script = document.createElement('script')
script.textContent = `(${installInterceptor.toString()})();`
script.dataset.dsfInjector = '1'
;(document.head || document.documentElement).appendChild(script)
script.remove()
