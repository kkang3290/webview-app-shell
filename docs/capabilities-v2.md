# 多窗口与系统集成（桌面）

原生只提供窗口、系统菜单、退出控制等原语，内容与业务行为由网页决定。通过 `capabilities: ["windows", "system"]` 按需启用，插件位于 `window.appshell.plugins`。

此文档只列已实现的桌面能力；未实现的工作区、文本提取和统一系统音频接口不属于当前 API。

## Windows

辅助窗口只能加载同一本地站点的路由，共享登录态和插件白名单。

```ts
interface WindowSpec {
  id: string
  route: string
  kind: 'floating' | 'panel' | 'overlay'
  bounds?: { width: number; height: number; x?: number; y?: number; anchor?: 'bottom-right' | 'top-right' | 'center' }
  alwaysOnTop?: boolean
  rememberBounds?: boolean
  excludeFromCapture?: boolean
  focusable?: boolean
  displayId?: string
  transparent?: boolean
}

Windows.open(spec: WindowSpec): Promise<{ id: string }>
Windows.close({ id }): Promise<void>
Windows.setVisible({ id, visible }): Promise<void>
Windows.setBounds({ id, bounds }): Promise<void>
Windows.setIgnoreMouse({ id, ignore, forward? }): Promise<void>
Windows.setFocusable({ id, focusable, focus? }): Promise<void>
Windows.list(): Promise<{ windows: { id; visible; bounds }[] }>
Windows.post({ to: string | 'main' | '*', message: unknown }): Promise<void>
Windows.capturePage({ id, rect? }): Promise<{ png: string }>
```

事件使用 `addListener()` 订阅：`message`、`closed`、`visibility`、`appDeactivated`。

- `route` 必须是站内路径，拒绝站外 URL。
- overlay 只能由主窗口或 panel 创建；窗口越站导航会被阻止。
- `post` 的 `'*'` 向应用的其他窗口发送消息，业务仍需校验消息内容。
- `displayId` 来自 `ScreenCapture.listSources()`；多显示器坐标和录屏排除效果需在目标 OS 验收。
- 子窗口使用 context isolation、禁用 Node integration 并启用 sandbox。

## SystemShell

```ts
SystemShell.setTray({ visible, tooltip?, items: { id, label, enabled? }[] }): Promise<void>
SystemShell.mainWindow({ action: 'show' | 'hide' | 'minimize' | 'restore' | 'focus' }): Promise<void>
SystemShell.setHideBehavior({ intercept: boolean }): Promise<void>
SystemShell.preventQuit({ reason: string | null }): Promise<void>
SystemShell.openPrivacySettings({ pane: 'microphone' | 'screen' | 'systemAudio' | 'notifications' }): Promise<void>
```

事件：`trayItem`、`mainWindowWillHide`、`prepareQuit`。是否开浮窗、保存业务状态或允许退出由网页处理；原生只负责系统操作与确认。

手机端没有这两个统一插件。状态栏使用平台已有的 `StatusBarTheme`；权限使用 `Permissions`。屏幕共享单独见 [screen-capture.md](screen-capture.md)。

## 扩展边界

不属于通用能力的可信原生代码可用 [业务扩展](desktop-extension.md) 加入。扩展能使用 Node/Electron 或平台原生 API，不是沙箱插件；需自行保持 IPC 来源、URL 与权限检查。
