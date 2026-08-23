/**
 * MAIN world 入口（由 CRXJS 以 world:"MAIN" 注入）。
 * 作为同步脚本注入的 CSP 兜底：若页面 CSP 禁止内联脚本，
 * 同步注入失败时本入口仍会（异步）完成打补丁。
 * 幂等：installInterceptor 内部有 __dsfInterceptorInstalled 守卫。
 */
import { installInterceptor } from '@/inject/interceptor'

installInterceptor()
