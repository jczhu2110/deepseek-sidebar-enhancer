import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'DeepSeek 对话文件夹管理',
  version: '0.1.0',
  description:
    '为 DeepSeek 网页版侧边栏对话记录提供文件夹分类、重命名、拖拽归类与排序增强。',
  permissions: ['storage'],
  host_permissions: ['*://chat.deepseek.com/*'],
  content_scripts: [
    {
      // 同步把拦截器注入 MAIN world（赶在 DeepSeek 快照 fetch 之前）
      matches: ['*://chat.deepseek.com/*'],
      js: ['src/content/inject-bootstrap.ts'],
      run_at: 'document_start',
    },
    {
      // CSP 兜底：若内联脚本被禁，由 CRXJS MAIN-world 异步打补丁
      matches: ['*://chat.deepseek.com/*'],
      js: ['src/inject/inpage.ts'],
      run_at: 'document_start',
      world: 'MAIN',
    },
    {
      matches: ['*://chat.deepseek.com/*'],
      js: ['src/content/main.ts'],
      run_at: 'document_idle',
    },
  ],
})
