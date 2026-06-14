# chrome-do-action

远程控制 Chrome 浏览器的工具链，通过 WebSocket 在服务端和浏览器之间传递指令。

## 架构

```
┌─────────────┐     WebSocket      ┌──────────┐     WebSocket      ┌──────────────┐
│  CLI 工具    │ ◄───────────────► │  服务端   │ ◄───────────────► │ Chrome 扩展   │
│  chrome-do-  │   cli / cli_result │  server  │   command / result │  (浏览器端)   │
│  action      │                    │          │                    │              │
└─────────────┘                    └──────────┘                    └──────────────┘
```

- **CLI 工具**：命令行客户端，发出指令后等待结果返回再退出
- **服务端**：中转 hub，维护浏览器连接注册表，转发 CLI 指令到浏览器，回传结果
- **Chrome 扩展**：在浏览器中执行具体操作（点击、输入、获取内容、打开标签页等）

一个服务端可以连接多个浏览器客户端，CLI 通过 `list` 查看在线客户端，通过 `send <nodeId>` 指定目标。

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

生产环境建议用 supervisor 守护：

```bash
supervisord -c server/supervisord.conf
```

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

加载后点击扩展图标进入配置页，填写：

- **节点名称**：自定义标识（如 `OfficePC`）
- **服务端地址**：`ws://127.0.0.1:12345`
- 勾选「自动连接」

扩展会在后台维持 WebSocket 长连接，断线后自动重试（每轮 3 次，间隔 15 秒）。

### 3. CLI 工具

```bash
cd cli
npm install
npm run build
npm link
```

安装后 `chrome-do-action` 命令全局可用。

## CLI 使用

### 查看在线客户端

```bash
chrome-do-action --server ws://127.0.0.1:12345 list
# abc123  MyChrome  192.168.1.5  online 120s
```

### 浏览器命令（无需指定标签页）

```bash
# 打开新页面（等待加载完成后返回）
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> open https://example.com

# 列出所有标签页
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> list_tabs

# 关闭标签页
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> close_tab current
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> close_tab 456
```

### 页面命令（需指定标签页：`current` 或数字 tabId）

```bash
# 获取页面信息
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_title current
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_url current
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_text current
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_html current

# 获取指定元素内容
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_text current '{"selector":"#main"}'
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_html current '{"selector":"#content"}'

# 点击（三种定位方式）
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> click current '{"selector":"#submit"}'
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> click current '{"text":"登录"}'
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> click current '{"x":100,"y":200}'

# 输入文本
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> type current '{"selector":"#name","text":"hello"}'

# 滚动页面
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> scroll current '{"y":500}'
```

### 命令参考

| 命令 | 类型 | 说明 |
|---|---|---|
| `open <url>` | 浏览器 | 打开新标签页，等待加载完成 |
| `list_tabs` | 浏览器 | 列出所有标签页 |
| `close_tab <id>` | 浏览器 | 关闭标签页，`current` 表示当前页 |
| `click` | 页面 | 点击元素（selector / text / x,y） |
| `type` | 页面 | 输入文本（selector + text） |
| `get_title` | 页面 | 获取页面标题 |
| `get_url` | 页面 | 获取当前 URL |
| `get_text` | 页面 | 获取文本内容，可选 selector |
| `get_html` | 页面 | 获取渲染后 HTML，可选 selector |
| `scroll` | 页面 | 滚动页面，参数 `{y}` |

## 协议

服务端监听 WebSocket 连接，消息为 JSON 格式。

### 浏览器 ↔ 服务端

| 消息 | 方向 | 说明 |
|---|---|---|
| `register` | 浏览器 → 服务端 | 注册，携带 `nodeName` |
| `register_ack` | 服务端 → 浏览器 | 分配 `nodeId` |
| `command` | 服务端 → 浏览器 | 下发执行指令 |
| `command_result` | 浏览器 → 服务端 | 返回执行结果 |
| `ping` / `pong` | 双向 | 心跳 |

### CLI ↔ 服务端

| 消息 | 方向 | 说明 |
|---|---|---|
| `cli` | CLI → 服务端 | 发送指令（`list` / `send`） |
| `cli_result` | 服务端 → CLI | 返回结果 |

## 行为特性

- **点击等待导航**：点击后检测页面跳转，自动等待新页面加载完成后返回最终 URL 和标题
- **滚动等待加载**：滚动后等待 DOM 稳定（MutationObserver），适用于 AJAX 分页加载场景
- **标签页排队**：同一标签页的命令按顺序执行，不会并发
- **断线重试**：浏览器扩展断线后每 15 秒一轮，每轮连续重试 3 次
- **日志记录**：服务端按天滚动日志文件，记录连接、注册、命令、结果等完整链路
