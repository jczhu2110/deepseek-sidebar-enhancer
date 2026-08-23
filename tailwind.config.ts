import type { Config } from 'tailwindcss'

export default {
  // 仅在 Shadow DOM 内使用，关闭 preflight 避免任何全局重置
  corePlugins: {
    preflight: false,
  },
  darkMode: 'class',
  content: ['./src/**/*.{vue,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Helvetica Neue',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif',
        ],
      },
      // 字号体系跟随宿主基准字号（--dsf-font-size 由 content script 从原生
      // 侧边栏提取，回退 13px）：档位间关系固定，宿主换字号时整体等比缩放
      fontSize: {
        heading: [
          'calc(var(--dsf-font-size, 13px) + 1px)',
          { lineHeight: 'calc(var(--dsf-font-size, 13px) + 7px)', fontWeight: '400' },
        ],
        subheading: [
          'var(--dsf-font-size, 13px)',
          { lineHeight: 'calc(var(--dsf-font-size, 13px) + 5px)', fontWeight: '400' },
        ],
        body: [
          'var(--dsf-font-size, 13px)',
          { lineHeight: 'calc(var(--dsf-font-size, 13px) + 6px)', fontWeight: '400' },
        ],
        caption: [
          'calc(var(--dsf-font-size, 13px) - 1px)',
          { lineHeight: 'calc(var(--dsf-font-size, 13px) + 4px)', fontWeight: '400' },
        ],
        micro: [
          'calc(var(--dsf-font-size, 13px) - 2px)',
          { lineHeight: 'calc(var(--dsf-font-size, 13px) + 2px)', fontWeight: '400' },
        ],
      },
      letterSpacing: {
        label: '0.08em',
      },
      // 圆角体系跟随宿主对话项圆角（--dsf-radius，回退 6px）
      borderRadius: {
        ds: 'var(--dsf-radius, 6px)',
        pop: 'calc(var(--dsf-radius, 6px) + 2px)',
        modal: 'calc(var(--dsf-radius, 6px) + 4px)',
        btn: 'calc(var(--dsf-radius, 6px) - 2px)',
      },
      transitionDuration: {
        fast: '120ms',
        ds: '180ms',
      },
      zIndex: {
        menu: '9990',
        toast: '9998',
        modal: '9999',
      },
    },
  },
  plugins: [],
} satisfies Config
