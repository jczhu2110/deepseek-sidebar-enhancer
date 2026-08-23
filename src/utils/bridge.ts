import {
  BRIDGE_SOURCE,
  type BridgeMessage,
  type BridgeMessageType,
} from '@/types'

const VALID_TYPES: readonly BridgeMessageType[] = [
  'sessions',
  'session-renamed',
  'session-deleted',
  'interceptor-ready',
  'dsf-location-changed',
  'dsf-token',
]

/** 校验消息是否为本扩展发出的桥消息（防止页面伪造） */
export function isBridgeMessage(data: unknown): data is BridgeMessage {
  if (typeof data !== 'object' || data === null) return false
  const msg = data as Record<string, unknown>
  return (
    msg.source === BRIDGE_SOURCE &&
    typeof msg.type === 'string' &&
    VALID_TYPES.includes(msg.type as BridgeMessageType)
  )
}

/** MAIN world -> 页面派发，content script 在同一 window 上监听 */
export function postBridgeMessage(message: BridgeMessage): void {
  window.postMessage(message, window.location.origin)
}

export type BridgeHandler = (message: BridgeMessage) => void

/** content script 侧订阅桥消息，返回取消订阅函数 */
export function onBridgeMessage(handler: BridgeHandler): () => void {
  const listener = (event: MessageEvent) => {
    // 仅接受同源、且由本窗口派发的消息
    if (event.source !== window) return
    if (event.origin !== window.location.origin) return
    if (!isBridgeMessage(event.data)) return
    handler(event.data)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
