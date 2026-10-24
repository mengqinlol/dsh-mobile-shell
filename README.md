# dsh-mobile-shell

把 DeepSeek Harness 的 Web GUI 在**手机**上真正用起来：悬浮式侧栏、页面锁死只滚对话、
点输入框不放大、切会话不抢焦点、键盘弹出时输入框贴着键盘上移，并给非安全上下文补上
`crypto.randomUUID`。

*English*: A mobile shell layer for the DeepSeek Harness Web GUI — drawer overlay,
page lock, no iOS focus zoom, keyboard-aware composer, and the
`crypto.randomUUID` polyfill that plain-HTTP (non-secure context) browsing needs.

![悬浮抽屉](docs/drawer.png)
![对话](docs/chat.png)

---

## 为什么需要它

DSH 的 Web GUI 是按桌面设计的：打包后的前端 CSS 里**没有任何宽度 media query**。
在手机上（尤其是通过公网 IPv6 + 明文 HTTP 打开时）会遇到这些问题：

| 问题 | 原因 | 本插件的做法 |
|---|---|---|
| 前端 RPC 全失败、会话列表空白 | 浏览器只在安全上下文（HTTPS / localhost）暴露 `crypto.randomUUID`，明文 HTTP 下没有 | 注入标准 UUID v4 polyfill（`crypto.getRandomValues`） |
| 侧栏展开把对话挤成一条缝 | 外壳是 CSS grid，列宽写在内联样式里，且 grid item 有 `overflow: hidden` | 固化列宽，侧栏改为**覆盖式悬浮卡片** + 遮罩，点外面收起 |
| 上下滑动时整页跟着动 | iOS 页面级回弹 / 地址栏收起；插件统计行还把滚动容器横向撑宽 30px | `html/body` 钉成视口、页面不可滚，只有对话滚动；隐藏统计行 |
| 点输入框整页被放大 | 输入框是 `contenteditable` 的 div，字号 14px（< 16px 即触发 iOS 聚焦缩放） | 强制 16px、改写 `meta viewport`、拦 `gesturestart` |
| 切会话自动弹键盘 | 会话视图挂载时会 `focus()` 输入框 | 只保留「用户自己点进去」的聚焦，其余立刻 `blur()` |
| 键盘挡住输入框 | iOS 不为软键盘缩小布局视口 | 用 `visualViewport` 算键盘 inset，对话列整体上移 |

另外：切会话时抽屉自动收起、设置弹窗改为全屏 + 顶部分组横滑、触控目标 ≥ 32px。

## 安装

插件就是一个普通的 DSH bundle（`dsh.bundle.patch` → `cordis.patch.yml`），不修改 DSH 本体。

```sh
# 从本地目录
dsh plugin --profile web add file:/path/to/dsh-mobile-shell

# 或从 Git
dsh plugin --profile web add git+https://github.com/mengqinlol/dsh-mobile-shell.git

# 开发时用 link:，profile 直接跑源码
dsh plugin --profile web add link:/path/to/dsh-mobile-shell
```

安装后重启 DSH 服务；之后打开 Web GUI 即生效（没有配置项）。

> 只针对窄屏（`max-width: 820px`）生效，桌面端观感不变。建议配合 HTTPS 使用；
> 明文 HTTP 下插件只是「让界面能用」，并不会加密流量。

## 结构

```
dsh-mobile-shell/
├── package.json          # dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml      # 只插入自己这一行，不动任何其它行
├── lib/index.js          # index tap：polyfill + <style> + <script>
├── assets/mobile-fix.css # 移动端样式（每次请求读盘）
├── assets/shell.js       # 移动端行为（每次请求读盘）
└── test/smoke.mjs        # 挂载插件并断言注入内容
```

`lib/index.js` 通过 webserver 的 `tapIndex` 钩子改写 `index.html`；两个资源文件在**每次
请求时读盘**，所以改样式只需刷新页面，不必重启服务。只有改 `lib/index.js` 本体才需要重启
（Node 的 ESM 模块缓存）。

## 兼容性

- 在 DSH `0.2.1-rc.2`（Windows / Electron）上实测。
- 选择器优先用 DSH 的稳定属性（`data-slot` / `data-composer-card` / `role="dialog"`），
  再用 `:has()` 做结构定位；个别 hash 类名（`BynINW_*`、`Dc7zOa_*`）作为兜底。
  DSH 更新后若布局变化，最坏情况是某条修饰失效，不会让页面打不开。
- 不绑定端口、不改 webserver 行：绑定地址始终由 `dsh web --host/--port` 决定。

## 开发

```sh
npm test        # 无需依赖：挂载插件 + 断言注入内容
```

## 许可

MIT。`crypto.randomUUID` polyfill 的思路与实现源自
[dsh-lan-access](https://github.com/Leon0555/dsh-lan-access)（MIT © Leon0555），其余为本项目实现。
