# DeepSeek Sidebar Enhancer — UI 设计规范

> 设计语言：**宿主对齐（Host-Aligned）** —— 颜色 / 字体 / 行高 / 圆角从 DeepSeek
> 原生侧边栏实时提取；交互性格保持本扩展自己的克制极简（幽灵按钮 / 留白分层 / 单色反馈）。
> 适用范围：`src/sidebar/` 下全部 Shadow DOM 内 UI。所有样式必须限定在 `.dsf-root` 作用域。

---

## 1. 设计原则

| 原则 | 说明 |
|---|---|
| 宿主对齐 | 视觉基准（纸面 / 文字 / 字体 / 字号 / 行高 / 圆角 / 强调色）运行时从原生侧边栏提取；提取失败回退内置暖灰色板。侧边栏与主聊天区不出现"两种产品"的割裂感 |
| 派生一致 | hover / active / 次要文字 / 浮层表面等全部由基准令牌经 `color-mix` 派生，宿主换肤时整套交互色自动跟随，无需维护两套色板 |
| 留白即层级 | 不用边框、分隔线划分结构；层级只由间距、缩进与底色微差表达 |
| 幽灵按钮 | 按钮一律无底色、无边框，文字 / 图标本身即界面；hover 仅给一层极浅中性底 |
| 单色克制 | 界面近乎单色；强调色只出现在焦点环与主操作文字上，状态色仅存于文字 |
| 全键盘可达 | 所有可交互元素具备键盘路径与 `focus-visible` 焦点环；菜单/弹窗有焦点管理与 Esc 出口 |
| 反馈即诚实 | 异步操作有 pending 态；失败保留原状可重试，绝不静默改本地造成两端不一致 |

## 2. 主题机制：提取 + 派生

### 2.1 令牌架构（两级）

**基准令牌**（可被宿主提取值以内联变量覆盖，回退值写在 `main.css`）：

| 令牌 | 回退值（亮） | 提取来源 |
|---|---|---|
| `--dsf-text` | `#292824` | 原生对话项文字色（`getComputedStyle`） |
| `--dsf-surface` | `#F5F4F1` | 自原生列表向上第一个不透明背景（侧边栏纸面） |
| `--dsf-accent` | `#4D6BFE` | 原生「新对话」按钮品牌色（仅有彩色时采纳；回退值即 DeepSeek 品牌蓝） |
| `--dsf-font` | 系统字体栈 | 原生对话项 `font-family` |
| `--dsf-font-size` | `13px` | 原生对话项 `font-size` |
| `--dsf-radius` | `6px` | 原生对话行 `border-radius` |
| `--dsf-row-h` | `32px` | 原生对话行高度（仅列表可见时可测，隐藏后保留上次值） |

暗色回退（`.dsf-root.dark`）：`--dsf-text: #E7E5E1`、`--dsf-surface: #191817`、`--dsf-accent: #7A8FFF`。

**派生令牌**（`color-mix` 自动适配，禁止手写具体色值）：

| 令牌 | 派生式 |
|---|---|
| `--dsf-text-dim` / `-faint` | text 62% / 38% mix surface |
| `--dsf-hover` / `--dsf-active` | text 4.5% / 7% mix transparent |
| `--dsf-hover-solid` | text 4.5% mix surface（hover 底的**不透明**等效色，行内浮层遮挡用） |
| `--dsf-border` / `-strong` | text 7% / 20% mix transparent（发丝线，仅功能性细节） |
| `--dsf-accent-faint` / `--dsf-ring` | accent 8% / 35% mix transparent |
| `--dsf-danger-soft` | danger 9% mix transparent（danger 为扩展自有暖朱红，无宿主来源） |
| `--dsf-surface-raised` | text 4% mix surface（浮层：暗色提亮 / 亮色微沉，均自然分层） |
| `--dsf-field` | text 5% mix transparent（无边框输入底） |

### 2.2 提取时机（content/main.ts）

1. **挂载时**（原生列表隐藏前）：`extractDesignTokens()` 全量提取（含行高/圆角布局测量）；
2. **主题切换时**（`watchTheme` 回调）：重新提取颜色类令牌（计算样式即时反映新主题），
   行高不可测则保留上次值；
3. 提取结果以内联 CSS 变量写入 `.dsf-root`（优先级高于两套静态回退块，天然覆盖明暗）。

### 2.3 字号 / 圆角体系

Tailwind 令牌全部跟随基准变量，宿主字号变化时排版等比缩放：

- 字号五档：`heading`(+1px) / `subheading`(基准) / `body`(基准) / `caption`(-1px) / `micro`(-2px)，行高同步 +7/+5/+6/+4/+2px，全部 400 字重
- 圆角四档：`ds`(基准) / `pop`(+2px) / `modal`(+4px) / `btn`(-2px)
- 阴影两档 `--dsf-shadow-pop/-modal`（纯环境光、无描边，暗色在 `.dark` 加深）

### 2.4 动效与层级

| 令牌 | 值 | 用途 |
|---|---|---|
| `duration-fast` | 120ms | hover / 颜色 / 透明度 |
| `duration-ds` | 180ms | Sortable / 折叠 |
| 浮层进入 | `dsf-pop`：scale 0.96→1 + fade + 4px 位移，160ms | 菜单 / 弹窗 |
| 折叠 | `grid-template-rows 0fr↔1fr` + opacity，180ms | 文件夹展开 |
| z-index | menu 9990 < toast 9998 < modal 9999 | Shadow DOM 内 |

## 3. 布局与滚动

- **滚动自持**：host 复刻原生列表的 flex 伸展/显式高度并 `overflow-y: auto`，
  不依赖宿主父级溢出行为；`.dsf-root` 为 `min-height: 100%`（铺满 host 即铺满侧边栏）。
  host 滚动条沿用页面样式（与原生一致）。heal 自愈复位时不移动 host。
- 根容器：`px-2 pt-3 pb-8`，列表 `gap-1`
- 自上而下：**新建文件夹入口 → 文件夹树区 → 未分类对话分区 → 全局浮层**
- 分节头：纯文字（11px + 0.08em 宽字距 + faint 色）+ 右侧 `tabular-nums` 计数；
  上方 24px 大留白即分隔；**拖拽至根区域时整行挂 `dsf-drop-active`，文字切换为「松手移回未分类」**
- 嵌套层级：子级容器 `ml-[18px]` 纯缩进，不画引导线

## 4. 组件规范

### 4.1 列表行（`.dsf-row`，四处共用：新建按钮 / 文件夹头 / 对话行 / 菜单项）

```text
flex / items-center / gap-2 / w-full
min-height: var(--dsf-row-h)（对齐宿主行高）
padding: 4px 10px；圆角 var(--dsf-radius)；120ms 颜色过渡
```

| 状态 | 表现 |
|---|---|
| 默认 | 透明底，文字 `--dsf-text` |
| hover | 底 `--dsf-hover`；操作按钮 opacity 0→1 渐显 |
| active（当前对话） | 底 `--dsf-active`（中性）+ `aria-current="true"`，无 accent 色 |
| focus-visible | 2px `--dsf-ring` 焦点环，offset 2px |
| 拖拽 chosen | 底 `--dsf-hover`；ghost 占位 35% 不透明度 |
| **放置目标** | `dsf-drop-active`：底 `--dsf-active` + `inset 0 0 0 1.5px var(--dsf-border-strong)` 中性内描边（不用蓝） |

- 图标 14–16px、stroke-width 2、中性色；行 hover 联动提亮（`.dsf-icon--group-hover*`）
- hover 操作组：胶囊底色用 `--dsf-hover-solid`（hover 等效实色，融入行底，无色块感）
- 计数徽章 11px faint，hover 让位淡出

### 4.2 新建文件夹按钮（幽灵操作行）

`.dsf-row` + 无边框透明底，`+` 图标 + `text-dim` 文字；hover 底 `--dsf-hover` + 文字转墨色。
创建后立即进入行内重命名并标记「新建未提交」：**Esc 取消或提交空名时自动回收空壳文件夹**。

### 4.3 更多菜单（ActionMenu）

- 面板：`--dsf-surface-raised` + `backdrop-blur(12px)` + `shadow-pop` + `rounded-pop`，宽 `ACTION_MENU_WIDTH`(144px，组件导出，勿复制)
- **定位**：锚点为触发按钮点击坐标；水平钳制视口内，底部空间不足时**实测高度后向上翻转**
- **键盘**：`role="menu"/"menuitem"`；打开即聚焦首项；↑/↓ 循环导航；Tab 圈定在菜单内；
  **Esc 关闭并归还焦点到触发按钮**（`source` 随 `more` 事件回传）
- danger 项：文字 `--dsf-danger`，hover 底 `--dsf-danger-soft`，与普通项以 6px 间距分隔
- 删除动作优先触发**原生删除按钮**（DeepSeek 原生确认框 + 拦截器回传统步）；
  原生入口定位失败才降级为自绘确认框

### 4.4 确认弹窗（ConfirmDialog：透明捕获层 + 悬浮卡片）

- 无遮罩变暗：透明点击捕获层 + 卡片居中于**侧边栏区域**（视口级定位钳制），320px 宽
- **焦点管理**：打开即聚焦「取消」（危险操作默认安全位）；Esc 取消；
  Tab 在两按钮间圈定；Enter 激活当前聚焦按钮
- 主按钮 pending：`pending` 时禁用 + 文案「删除中…」防双击
- 删除 API 失败：**保留条目 + 错误 toast**，不静默本地移除

### 4.5 行内重命名（对话 / 文件夹共用）

输入框占位原标题；Enter 提交 / Esc 取消 / blur 提交。
**对话重命名（走 API）提交期间**：输入框保持、置 disabled + 右侧 Loader2 spinner；
成功后关闭；失败恢复可编辑（草稿保留、提交守卫重置）可重试。

### 4.6 Toast

侧边栏区域底部居中胶囊（水平坐标 = 侧边栏根容器中心，**非整页中央**）；
`role="status"`；毛玻璃 + raised + shadow-pop；2400ms 自动消失。

### 4.7 键盘可达性总则

- 对话行 / 文件夹头：`role="button"` + `tabindex="0"`（编辑态 -1）+ Enter/Space 激活；
  文件夹头另有 `aria-expanded`
- 菜单项 / 弹窗按钮为原生 button；`focus-within` 与 hover 等价显现行内操作
- Shadow DOM 内 `document.activeElement` 不可靠，焦点位置一律组件自跟踪

## 5. 数据同步体验

- **当前会话高亮**：MAIN world 补丁 `pushState/replaceState` → 桥消息 `dsf-location-changed`
  → App 零延迟刷新；popstate 兜底；3s 低频轮询仅作最后防线（曾为 800ms 轮询）
- 点击对话：乐观高亮 + 转发原生点击（SPA 路由完整执行）

## 6. Class 钩子契约（不可更名）

| 钩子 | 类型 | 消费方 |
|---|---|---|
| `.dsf-root` / `.dark` | 主题作用域 | content/main.ts 挂载与切换 |
| `.dsf-row` | 列表行基类 | 新建按钮 / 文件夹头 / 对话行 / 菜单项 |
| `.dsf-btn-ghost(--accent/--danger)` | 幽灵按钮 | 弹窗按钮组 |
| `.dsf-ghost` `.dsf-chosen` | Sortable class | 三处 draggable |
| `.dsf-folder-handle` | Sortable handle 选择器 | FolderItem / App |
| `.dsf-no-drag` | Sortable filter 选择器 | 重命名输入框 / 操作组 |
| `.dsf-drop-active` | 放置目标反馈（中性底 + 内描边） | App / FolderItem |
| `.dsf-enter` / `.dsf-pop` / `.dsf-fade-*` | 进入/过渡动画 | 各浮层与 FolderItem |
| `data-dsf-kind` | 拖拽类型过滤 | utils/dnd.ts |
| `ACTION_MENU_WIDTH` | 菜单宽度常量导出 | ActionMenu（勿在 App 复制） |
