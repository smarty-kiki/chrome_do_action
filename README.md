# chrome-do-action

远程控制 Chrome 浏览器的工具链，通过 WebSocket 在三方之间传递指令：CLI → 服务端 → Chrome 扩展 → Content Script。

## 架构

```
┌─────────────┐     WebSocket      ┌──────────┐     WebSocket      ┌──────────────┐
│  CLI 工具    │ ◄───────────────► │  服务端   │ ◄───────────────► │ Chrome 扩展   │
│  chrome-do-  │   cli / cli_result │  server  │   command / result │  (Service     │
│  action      │                    │  (Node)  │                    │   Worker)    │
└─────────────┘                    └──────────┘                    └───────┬──────┘
                                                                       │ chrome.tabs.sendMessage
                                                                       ▼
                                                            ┌──────────────────────┐
                                                            │  Content Script      │
                                                            │  (页面内执行实际操作)  │
                                                            └──────────────────────┘
```

- **CLI 工具**：命令行客户端，发出指令后阻塞等待结果返回再退出
- **服务端**（Node.js）：中转 hub，维护浏览器连接注册表，转发 CLI 指令到浏览器，回传结果
- **Chrome 扩展**：在浏览器中接收服务端指令，通过 `chrome.tabs.sendMessage` 将页面级命令分发到 Content Script
- **Content Script**：注入到页面中执行实际操作（点击、输入、获取内容等）

一个服务端可以连接多个浏览器客户端。CLI 通过 `list` 查看在线客户端，通过 `send <nodeId>` 指定目标浏览器。

## 安装

### 1. 服务端

```bash
cd server
npm install
npm run build
```

启动：

```bash
node dist/server.js --port 12345 --log-dir /tmp/chrome/
```

参数：
- `--port`：WebSocket 监听端口（必填）
- `--log-dir`：日志目录（必填），日志按天滚动，文件名为 `server-YYYY-MM-DD.log`

生产环境建议用 supervisor 守护：

```bash
supervisord -c server/supervisord.conf
```

配置文件位于 `server/supervisord.conf`，默认监听 `12345` 端口，日志输出到 `/tmp/chrome/`。

### 2. Chrome 扩展

```bash
cd chrome-extension
npm install
npm run build
```

在 Chrome 中加载：

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `chrome-extension/dist/` 目录

加载后点击扩展图标（弹出窗）或右键「选项」进入配置页，填写：

- **节点名称**：自定义标识（如 `OfficePC`），用于 CLI 定位此浏览器
- **服务端地址**：`ws://127.0.0.1:12345`
- **自动连接**：勾选后扩展启动/断线时自动重连

扩展行为：
- 后台维持 WebSocket 长连接，通过 Service Worker 管理
- 断线后按轮次重试：每轮连续重试 3 次（立即重试），3 次用完后等待 15 秒开启下一轮，计数器归零重新计数
- 每 30 秒发送 ping 保活，服务端回应 pong
- 每 15 秒触发一次 keepalive alarm，检查是否需要自动重连
- 页面级命令通过 `chrome.tabs.sendMessage` 发送到 Content Script
- 浏览器级命令（open/list_tabs/close_tab）直接在 Service Worker 中处理
- 同一标签页的命令排队执行，不会并发
- Content Script 丢失时自动通过 `chrome.scripting.executeScript` 注入恢复

### 3. CLI 工具

```bash
cd cli
npm install
npm run build
npm link
```

`npm link` 使 `chrome-do-action` 命令全局可用。如需卸载：`npm unlink -g chrome-do-action-cli`。

## CLI 命令

### 通用选项

```
--server <ws_url>       服务端 WebSocket 地址（必填）
--field <paths>         逗号分隔的字段路径，浏览器端按需采集（如 --field "current.url,newTabs"）
                        支持命令：click、get_page_info、open
```

### 浏览器命令（无需指定标签页）

| 命令 | 用法 | 说明 |
|---|---|---|
| `open <url>` | `send <id> open <url>` | 打开新标签页（加入群组），等待加载完成，返回页面信息 |
| `list_tabs` | `send <id> list_tabs` | 列出所有标签页 |
| `close_tab <id>` | `send <id> close_tab current` | 关闭标签页，`current` 表示当前页，也可传入数字 tabId |

### 页面命令（需指定标签页：`current` 或数字 tabId）

| 命令 | 用法 | 说明 |
|---|---|---|
| `click` | `send <id> click <tab> <params>` | 点击元素（selector / text / x,y），返回页面状态和 iframe 变化 |
| `type` | `send <id> type <tab> <params>` | 输入文本（selector + text） |
| `get_text` | `send <id> get_text <tab> [selector]` | 获取文本内容，可选 selector |
| `get_html` | `send <id> get_html <tab> [selector]` | 获取渲染后 HTML，可选 selector |
| `get_page_info` | `send <id> get_page_info <tab> [--field ...]` | 获取页面信息（url / title / iframes），--field 按需采集 |
| `get_js_errors` | `send <id> get_js_errors <tab>` | 获取页面打开以来累积的 JS 错误 |
| `clear_js_errors` | `send <id> clear_js_errors <tab>` | 清除累积的 JS 错误 |
| `scroll` | `send <id> scroll <tab> <params>` | 滚动页面（支持 x/y 轴） |

`click` 的 params 示例：
```json
{"selector": "#submit"}              // CSS 选择器
{"text": "登录"}                      // 按可见文字查找
{"x": 100, "y": 200}                 // 坐标点击
{"selector": "css:button"}           // 显式 CSS 前缀
{"selector": "xpath://btn"}          // XPath 前缀
```

`scroll` 的 params 示例：
```json
{"y": 500}                   // 垂直滚动
{"x": 300, "y": 500}         // 水平 + 垂直
```

## 通信协议

所有消息为 JSON 格式，通过 WebSocket 传输。

### 消息类型

| 方向 | 类型 | 说明 |
|---|---|---|
| 扩展 → 服务端 | `register` | 浏览器扩展注册节点，携带 `nodeName` |
| 服务端 → 扩展 | `register_ack` | 注册确认，返回服务端生成的 `nodeId` |
| 服务端 → 扩展 | `command` | 执行指令，携带 `command` 和 `params` |
| 扩展 → 服务端 | `command_result` | 指令执行结果，携带 `commandId`、`success`、`data`、`error` |
| 双向 | `ping` / `pong` | 保活心跳，每 30 秒一次 |
| 双向 | `error` | 错误通知 |

每条消息带唯一 `id` 用于请求-响应关联。

### CLI 消息格式

```json
{
  "type": "cli",
  "id": "abc123",
  "payload": {
    "action": "send",
    "target": "<nodeId>",
    "command": "click",
    "tabId": "current",
    "params": { "selector": "#submit", "_field": ["current.url"] }
  }
}
```

`_field` 在 CLI 端注入到 `params` 中，一路透传到 Content Script，由 Content Script 按需采集。

## 返回格式

### open

页面和所有 iframe 加载完成后返回。iframe 标记是否同源，同源的 additionally 返回其内部 URL。

```json
{
  "url": "https://example.com",
  "title": "Example Domain",
  "iframes": [
    { "index": 0, "src": "https://ads.example.com", "sameOrigin": false },
    { "index": 1, "src": "/embedded", "sameOrigin": true, "url": "/embedded" }
  ]
}
```

> **注意**：`open` 的返回结果中不包含 `html` 字段。如需获取页面 HTML，请使用 `get_html` 命令。

### click（不跳转）

点击后返回点击描述 + 当前页面信息 + iframe 变化对比。`--field` 控制各字段是否采集。

```json
{
  "navigated": false,
  "clickDesc": {
    "text": "登录",
    "tag": "button"
  },
  "current": {
    "url": "https://example.com",
    "title": "Example",
    "iframes": [...]
  },
  "iframeChanged": false,
  "iframeChanges": [],
  "newTabs": []
}
```

各字段说明：
- `clickDesc`：点击描述对象，包含定位方式对应的字段（`text`+`tag`、`selector`+`tag`、或 `x`+`y`+`tag`）
- `navigated`：是否发生页面跳转
- `current`：当前页面信息，`--field` 不包含 `current` 时为 `null`
- `iframeChanged`：是否有 iframe 变化
- `iframeChanges`：iframe 变化详情数组
- `newTabs`：新打开的标签页数组，无新标签页时不出现此字段

### click（页面跳转 / 新标签页）

点击导致导航或打开新标签页时返回。包含原页面和新页面的完整信息。

```json
{
  "navigated": true,
  "current": {
    "url": "https://example.com/dashboard",
    "title": "Dashboard",
    "iframes": [...]
  },
  "newTabs": [
    {
      "tabId": 456,
      "url": "https://example.com/popped-up",
      "title": "Popped Up",
      "iframes": [...]
    }
  ]
}
```

### 其他页面命令返回

直接返回原始结果，不附带额外包装：

- `get_page_info` → `{ "url": "...", "title": "...", "iframes": [...] }`（对象，字段由 `--field` 控制，不含 `html`）
- `get_text` → `"登录"`（字符串）
- `get_html` → `"<!DOCTYPE html>..."`（字符串）
- `type` → `{ "success": true }`（对象）
- `scroll` → `{ "success": true, "data": { "scrollX": 0, "scrollY": 500 } }`（对象）
- `get_js_errors` → `{ "errors": [...], "count": 5 }`（对象）
- `clear_js_errors` → `{ "success": true }`（对象）
- `close_tab` → `{ "success": true, "data": { "tabId": 123 } }`（对象，包含关闭的 tabId）

### iframe 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `index` | number | iframe 在页面中的顺序索引 |
| `src` | string | iframe 标签的 src 属性（始终存在） |
| `sameOrigin` | boolean | 是否能读取 iframe 内部内容 |
| `url` | string | iframe 内部最终 URL（仅 sameOrigin 时存在） |

跨域 iframe 只返回 `src` 和 `sameOrigin: false`，不暴露内部内容。iframe 不再返回 `html` 字段。如需获取特定元素内容，使用 `get_html` / `get_text` 配合 selector。

## JS 错误收集

页面打开时即启动持久收集，监听 `window.onerror` 和 `unhandledrejection`，不阻塞任何命令。

- 错误持续累积，不清空
- 通过 `get_js_errors` 命令获取完整错误列表
- 通过 `clear_js_errors` 命令手动清空
- 在任意支持 `--field` 的命令中指定 `jsErrors`，返回结果中附带当前累积的错误

## --field 按需采集机制

`--field` 是核心过滤机制，在浏览器 Content Script 执行命令前判断所需字段，跳过不必要的 DOM 操作。

**支持 `--field` 的命令**：`click`、`get_page_info`、`open`（通过内部 `getFullPageInfo` 调用）

**字段路径语法**：逗号分隔，支持嵌套路径（点号分隔）
- `current.url` — 当前页面 URL
- `current` — 当前页面完整信息（url + title，不含 iframe）
- `current.iframes` — 当前页面的 iframe 列表
- `navigated` — 是否发生导航
- `iframeChanged` — iframe 是否有变化
- `iframeChanges` — iframe 变化详情
- `newTabs` — 新打开的标签页
- `jsErrors` — 累积的 JS 错误

**剪裁效果**：

| 调用 | 跳过 |
|---|---|
| `--field current.url` | 不读 outerHTML、不遍历 iframe |
| `--field current` | 不遍历 iframe |
| `--field current,iframeChanges` | 读页面信息 + 前后对比 iframe |
| `--field navigated` | 不读页面信息、不对比 iframe |
| 无 `--field` | 全量采集 |

> **注意**：`--field html` 在 `get_page_info` 和 `open` 中会被 Content Script 采集，但服务端在转发时会剥离 `html` 字段，不会传递给 CLI。如需获取页面 HTML，请使用 `get_html` 命令。

## 行为特性

- **标签群组**：`open` 打开的页面自动加入 `chrome_do_action` 标签群组（灰色），群组为空时自动清除
- **点击导航检测**：点击后 Content Script 监听 `beforeunload` 事件（300ms 窗口），设置 `navigated` 标志。服务端读取该标志判断是否发生跳转，若发生则等待新页面加载完成后返回完整信息
- **新 tab 检测**：点击前后对比窗口中的 tab 列表，主动发现 `target="_blank"` 打开的新 tab
- **iframe 变化检测**：点击前后分别采集页面中所有 iframe 的 `src`，标记 `srcChanged`，Service Worker 汇总为 `iframeChanged` 和 `iframeChanges`
- **滚动等待加载**：`scroll` 使用 `smooth` 行为滚动，然后通过 `MutationObserver` 监听 DOM 变化，等待 500ms 无变动后返回（最长 3 秒超时）
- **DOM 稳定等待**：`wait_for_page` 先轮询检测 `readyState`，然后用 `MutationObserver` 等待 DOM 稳定
- **Content script 自动恢复**：content script 丢失时自动通过 `chrome.scripting.executeScript` 注入并重试
- **标签页排队**：同一标签页的命令通过队列串行执行，前一个命令完成后才执行下一个
- **断线重连机制**：浏览器扩展的 WebSocket 客户端按轮次重试——每轮连续重试 3 次（立即重试），3 次用完后等待 15 秒开启下一轮，计数器归零
- **标签页命令排队**：同一标签页的命令按顺序执行，不会并发
- **日志记录**：服务端按天滚动日志文件，记录连接、注册、命令、结果等完整链路

## 故障排查

### 服务端

- 检查 `--log-dir` 中的日志文件，按时间戳追踪连接和命令执行
- `[offline #N]` 日志表明浏览器断线，检查网络和服务端是否运行
- `[error #N] invalid JSON` 表示收到非 JSON 消息

### Chrome 扩展

- 弹出窗显示 ✕ 表示未连接，! 表示连接错误
- 断线后扩展会自动重试，弹出窗显示倒计时
- 点击元素时提示 `No active tab`：当前窗口没有可用的标签页
- 提示 `no content script loaded`：可能是 `chrome://` 页面或页面未完全加载
- 右键页面 → 「检查」→ Console 中看不到 WebSocket 错误（已被过滤），查看 service worker 日志：`chrome://extensions/` → 点击扩展的「service worker」链接

### CLI

- `WebSocket error`：服务端未运行或地址错误
- `Client "xxx" not found`：目标 nodeId 不存在或已离线，先用 `list` 确认在线客户端
- `Error: <message>`：浏览器执行命令时出错，查看服务端日志获取详情
