<p align="center">
  <img src="chrome-extension/icons/icon128.png" width="80" alt="chrome-do-action logo"/>
</p>

<h1 align="center">chrome-do-action</h1>

<p align="center">
  <strong>一条命令，远程操控真实 Chrome</strong><br/>
  不写脚本、不装测试框架，用命令行对任意一台装有扩展的浏览器执行点击、输入、上传、截图、抓取数据
</p>

<p align="center">
  <a href="https://github.com/smarty-kiki/chrome_do_action/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"/></a>
  <img src="https://img.shields.io/badge/Chrome-MV3-green.svg" alt="Chrome Manifest V3"/>
  <img src="https://img.shields.io/badge/TypeScript-5-blue.svg" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/transport-WebSocket-orange.svg" alt="WebSocket"/>
  <img src="https://img.shields.io/badge/dependencies-ws%20only-brightgreen.svg" alt="仅一个运行时依赖"/>
</p>

<p align="center">简体中文 · <a href="README.en.md">English</a></p>

---

## 为什么用这个项目？

遇到这些场景，写 Playwright / Selenium 脚本往往很重，而这个项目只需要**一条命令**：

- 帮别人/别处的电脑操作浏览器 —— 打开页面、填表单、点按钮、截图回传
- 登录公众号后台、富文本编辑器里**粘贴带格式的内容**、**上传封面图**（合成事件无效、文件对话框无法弹出的站点）
- 抓取页面内容、滚动加载的列表、监听页面上的 **JS 报错**
- 把浏览器操作的结果以**结构化 JSON** 吐出来，直接喂给脚本或 AI Agent

它把「浏览器 = 一台可编程的机器人」这个想法做成了一条流水线：

```
你的命令 → 服务端 → Chrome 扩展 → 页面内执行 → 结构化结果返回
```

- 命令行直达，**无需编写一行脚本**，支持管道组合（`| grep`、`| xargs`）
- 返回**结构化 JSON**，天然适合接入自动化流程与 LLM Agent
- **一个服务端可连多台浏览器**，远程操控异地电脑上的 Chrome
- 处理真实浏览器交互里的「疑难杂症」：真实点击、富文本、文件上传、hover 工具条

---

## 核心特性

| 能力 | 说明 |
|---|---|
| 🖱️ 页面操作 | 打开/刷新/关闭标签页、点击、输入、滚动、截图，覆盖浏览器绝大多数交互 |
| 🔥 真实点击 `real_click` | 通过 CDP 发送 `isTrusted=true` 的完整鼠标事件链，突破对合成事件免疫的站点（如微信公众平台后台），支持多级 hover 路径 |
| 📝 富文本编辑 | `type` 向 contenteditable 输入纯文本；`paste_rich` 直接粘贴带样式的 HTML，保留字号/颜色/加粗/排版 |
| 🖼️ 图片上传 | `upload_file` 将 base64 图片注入文件输入框并触发上传，绕过系统文件对话框 |
| 📸 CDP 截图 | 对页面「所见即所得」截图，本地自动保存 PNG，排查元素遮挡/浮层/滚动位置 |
| 🐛 JS 错误收集 | 页面加载即持续监听 `error` 与 `unhandledrejection`，随时查询/清空 |
| ⚡ 按需采集 `--field` | 指定返回字段，跳过不必要的 DOM 操作，命令更快、结果更精简 |
| 🔎 状态感知 | 自动检测页面跳转、新开标签页、iframe 变化，命令返回「操作后的世界」而非裸事件 |
| 🧩 iframe 支持 | 所有元素命令自动搜索 iframe（含跨域）并可直接读写操作，`iframes` 元数据对跨域也补全 `url`/`html` |
| 🔁 高可用 | 断线自动重连、同一标签页命令串行排队、Content Script 丢失自动恢复注入 |
| 🌐 多浏览器 | 一个服务端连接多个浏览器客户端，用节点名精确定位目标 |

---

## 架构

```
┌─────────────┐   WebSocket    ┌──────────┐   WebSocket   ┌──────────────┐
│  CLI 工具    │ ◄────────────► │  服务端   │ ◄───────────► │ Chrome 扩展   │
│  cda         │  cli / result │  (Node)  │  command/回执 │ (Service     │
└─────────────┘                └──────────┘               │  Worker)     │
                                                          └──────┬───────┘
                                                                 │ chrome.tabs.sendMessage
                                                                 ▼
                                                       ┌──────────────────────┐
                                                       │   Content Script     │
                                                       │   (页面内执行实际操作) │
                                                       └──────────────────────┘
```

- **CLI 工具 `cda`**：命令行客户端，发指令后阻塞等待结果，拿到结果直接退出（可放进任何脚本/管道）
- **服务端**（Node.js）：WebSocket 中转枢纽，维护浏览器连接注册表，转发 CLI 指令、回传结果，按天滚动写日志
- **Chrome 扩展**（Manifest V3）：Service Worker 维护长连接，把指令通过 `chrome.tabs.sendMessage` 分发到目标标签页
- **Content Script**：注入页面执行真实操作（点击、输入、取内容、收集错误等）

> 一个服务端可连**多个浏览器**。`cda list` 查看在线客户端，`cda send <节点名> ...` 指定目标。

---

## 快速开始

三条链路依次启动：**服务端 → Chrome 扩展 → CLI**。本机演示约 3 分钟。

### 1. 启动服务端

```bash
cd server
npm install
npm run build

node dist/server.js --port 12345 --log-dir /tmp/chrome/
```

生产环境可用自带 supervisor 配置守护：`supervisord -c server/supervisord.conf`。

### 2. 加载 Chrome 扩展

```bash
cd chrome-extension
npm install
npm run build
```

1. 打开 `chrome://extensions/`，开启「开发者模式」
2. 点击「加载已解压的扩展程序」，选择 `chrome-extension/dist/`
3. 点击扩展图标（或右键 → 选项）进入配置页，填写：
   - **节点名称**：给这台浏览器起个名字，如 `OfficePC`
   - **服务端地址**：`ws://127.0.0.1:12345`
   - **自动连接**：勾选后开机/断线自动重连

### 3. 安装 CLI

```bash
cd cli
npm install
npm run build
npm link          # 使 cda 命令全局可用
```

确认浏览器已上线：

```bash
cda list
# OfficePC  Chrome  192.168.1.5  online 123s
```

记下节点名，开始操作：

```bash
cda send OfficePC open https://example.com
```

> CLI 的 `--server` 默认为 `ws://127.0.0.1:12345`，本机运行时可以省略。

---

## 文档与集成

仓库里有两份与 README 互补的深度文档：

- **`SKILL.md`** — 面向 AI 助手（Claude Code / WorkBuddy 等）的 **Skill 定义**。接入 AI 工具后，AI 可直接调用 `cda` 操控本机 Chrome：复用你的登录态，帮你打开网页、填表单、给公众号排版、上传封面、截图确认。安装与自检流程见文件内「安装」章节。
- **`cli/help.md`** — CLI 的**完整命令手册**：每个命令的参数格式、返回结构、`--field` 字段路径，以及 `show`/`hide`、`real_click` 等命令的**设计动机**与适用场景。

> ⚠️ **打算把本项目装成你 Agent 的 skill？请务必通读这两个文件**——`SKILL.md` 定义 skill 的触发场景与标准流程（服务自检、拿节点 ID、命令写法），`cli/help.md` 沉淀了实战踩坑经验（坐标要截图确认、hover 菜单用 `show`、富文本与上传的边界行为等）。只读 README 就上手，Agent 大概率会踩同样的坑。日常手动用 CLI 则看下面「命令速查」即可。

---

## 常见用法示例

### 打开页面 & 确认加载

```bash
cda send OfficePC open https://example.com
# → { url: "https://example.com", title: "Example", iframes: [...] }

# 只想看 URL 和标题
cda send OfficePC open https://example.com --field "currentTab.url,currentTab.title"
# → { url: "https://example.com", title: "Example" }
```

### 登录表单（type + click）

```bash
cda send OfficePC type current '{"selector":"#username","text":"admin"}'
cda send OfficePC type current '{"selector":"#password","text":"secret"}'
cda send OfficePC click current '{"text":"登录"}' --field "currentTab.url,navigated"
# 登录成功后 navigated: true，并返回跳转后的新页面信息
```

### 公众号富文本排版 + 封面图上传

```bash
# 向 ProseMirror 编辑器粘贴带样式的排版
cda send OfficePC paste_rich current '{"selector":".ProseMirror","html":"<section style=\"text-align:center\"><span style=\"font-weight:bold\">小标题</span></section>"}'

# 把本地图片（先转 base64）注入 file input 触发上传
B64=$(base64 -i cover.jpg | tr -d '\n')
cda send OfficePC upload_file current "{\"selector\":\"input[type=file]\",\"base64\":\"$B64\",\"filename\":\"cover.jpg\",\"mime\":\"image/jpeg\"}"
```

### 真实点击（对合成事件免疫的站点）

```bash
# 微信后台：真实鼠标事件链（isTrusted=true）
cda send OfficePC real_click current '{"selector":"#submit"}'

# 多级 hover：先渐进经过封面预览、换一张图标（触发 hover 链），最后点击菜单项
cda send OfficePC real_click current '{"selector":".js_imagedialog","approach":[[720,224],[767,201],[811,200],[830,240]]}'
```

### 截图确认页面状态

```bash
cda send OfficePC screenshot current '{"path":"/tmp/shot.png"}'
# Screenshot saved: /tmp/shot.png (… bytes)
```

### 滚动加载 + 抓取表格 + 检查报错

```bash
cda send OfficePC open https://example.com/data
cda send OfficePC scroll current '{"y":99999}'          # 滚到底，等 DOM 稳定
cda send OfficePC get_text current '{"selector":"table"}'  # 提取表格文本
cda send OfficePC get_js_errors current                 # 页面是否报了 JS 错误
cda send OfficePC clear_js_errors current               # 清空后重新统计
```

---

## 命令速查

页面命令需指定标签页（`current` 或数字 tabId），浏览器命令不需要。

### 浏览器命令

| 命令 | 用法 | 说明 |
|---|---|---|
| `open <url>` | `send <id> open <url>` | 打开新标签页（自动加入标签群组），等待加载完成后返回页面信息 |
| `list_tabs` | `send <id> list_tabs` | 列出所有标签页 |
| `close_tab <id>` | `send <id> close_tab current` | 关闭标签页（`current` 或数字 tabId） |
| `refresh <id>` | `send <id> refresh current` | 刷新标签页，等待加载完成 |

### 页面命令

| 命令 | 用法 | 说明 |
|---|---|---|
| `click` | `send <id> click <tab> <params>` | 点击元素（selector / 文字 / 坐标） |
| `real_click` | `send <id> real_click <tab> <params>` | CDP 真实点击（`isTrusted=true`），支持 `approach` 渐进 hover 路径 |
| `type` | `send <id> type <tab> <params>` | 输入文本；支持 input/textarea 与 contenteditable 富文本 |
| `upload_file` | `send <id> upload_file <tab> <params>` | 向 file input 注入 base64 图片并触发上传 |
| `paste_rich` | `send <id> paste_rich <tab> <params>` | 向富文本编辑器粘贴带样式的 HTML |
| `get_text` | `send <id> get_text <tab> [selector]` | 获取元素/整页文本 |
| `get_css` | `send <id> get_css <tab> <selector>` | 获取所有匹配元素的 computed style |
| `get_page_info` | `send <id> get_page_info <tab> [--field ...]` | 获取页面信息（url / title / iframes） |
| `get_js_errors` | `send <id> get_js_errors <tab>` | 获取累积的 JS 错误 |
| `clear_js_errors` | `send <id> clear_js_errors <tab>` | 清空累积的 JS 错误 |
| `screenshot` | `send <id> screenshot <tab> <params>` | CDP 截图，`{"path":"/tmp/s.png"}` 本地保存 |
| `scroll` | `send <id> scroll <tab> <params>` | 滚动页面（smooth，等 DOM 稳定后返回） |

### click / real_click 定位方式

```json
{"selector": "#submit"}              // CSS 选择器（自动搜索 iframe，顶层优先）
{"text": "登录"}                      // 按可见文字查找（优先按钮/链接）
{"x": 100, "y": 200}                 // 坐标点击
{"selector": "css:button"}           // 显式 CSS 前缀
{"selector": "xpath://btn"}          // XPath 前缀
{"selector": "#submit", "frame": {"url": "mp.weixin.qq.com"}}  // 指定 iframe（URL 子串匹配）
```

### 其他命令参数

```json
// type —— 富文本按换行分段
{"selector": ".ProseMirror", "text": "第一段\n\n第二段"}

// upload_file —— base64 注入文件框
{"selector": "input[type=file]", "base64": "<base64>", "filename": "a.jpg", "mime": "image/jpeg"}

// paste_rich —— 粘贴带样式的 HTML（会先清空编辑器内容）
{"selector": ".ProseMirror", "html": "<section><span>hi</span></section>"}

// scroll —— 垂直/水平滚动
{"y": 500}                       // 或 {"x": 300, "y": 500}
```

---

## 特色能力详解

### 1. `real_click`：突破合成事件免疫的站点

许多后台（如微信公众平台的 Vue 组件）会忽略 `dispatchEvent` 合成的 click。`real_click` 通过 `chrome.debugger`（CDP）发送**完整真实鼠标事件链**：

```
渐进 mouseMoved（触发 mouseover/mouseenter/hover）
→ mousePressed（mousedown + focus）
→ mouseReleased（mouseup，浏览器自动合成 click）
```

- 鼠标移动采用**渐进步进**（每步 10px）而非瞬移，能真实触发途经元素的 hover 链
- 点击后鼠标**停留在目标上**，保留 hover 状态供连续操作
- `approach` 参数模拟「先移到触发点、再移到目标」的多级 hover 场景（如封面 hover 工具条）
- **iframe 支持**：自动搜索 iframe（含跨域），同源换算坐标、跨域走 CDP 定位，`frame` 参数可指定目标
- 副作用：attach 瞬间 Chrome 顶部会出现「正在调试此浏览器」横幅，随即消失

### 2. 富文本与文件上传：绕开最难的两个交互

- **`type`**：普通输入框直接设 value 并触发 `input`/`change`；contenteditable（ProseMirror、UEditor 等）聚焦后按换行分段插入，保留段落结构
- **`paste_rich`**：向富文本编辑器粘贴带内联样式的 HTML，保留字号/颜色/加粗/间距，等价于「全选删除后粘贴排好版的文档」
- **`upload_file`**：把 base64 图片注入 `input[type=file]` 并触发 `change`，页面监听后自动上传——无需操作系统文件对话框（比如没有辅助功能权限时也能传公众号封面）

### 3. `--field` 按需采集

在浏览器端执行命令前判断所需字段，**跳过不必要的 DOM 操作**，更快更省。

```bash
cda send OfficePC click current '{"text":"登录"}' --field "currentTab.url,navigated"
cda send OfficePC click current '{"text":"打开"}' --field "newTabs"
cda send OfficePC click current '{"selector":"#refresh"}' --field "iframeChanges"
```

支持 `click`、`get_page_info`、`open`。字段路径逗号分隔、点号嵌套：`currentTab.url`、`currentTab.iframes`、`navigated`、`newTabs`、`iframeChanges`、`jsErrors` 等。

### 4. 状态感知：操作之后自动「看结果」

- **导航检测**：点击后监听 `beforeunload`（300ms 窗口）设置 `navigated` 标志，若发生跳转则**等待新页面加载完成**再返回完整信息
- **新标签页检测**：点击前后对比窗口内 tab 列表，主动发现 `target="_blank"` 打开的页并等待其加载
- **iframe 变化检测**：点击前后采集所有 iframe 的 `src`，汇总 `iframeChanges`（`srcChanged` / `beforeSrc` / `afterSrc`）
- **DOM 稳定等待**：滚动后用 MutationObserver 等 500ms 无变动再返回（最长 3s 超时）

### 5. 可靠性设计

- **断线重连**：每轮连重试 3 次（立即重试），3 次用完等 15 秒开启下一轮
- **保活**：每 30 秒 ping/pong，Service Worker 定时器兜底
- **命令排队**：同一标签页的命令串行执行，天然避免并发冲突
- **Content Script 自愈**：脚本丢失时自动通过 `chrome.scripting.executeScript` 重新注入并重试
- **标签群组**：`open` 打开的页面自动归入灰色 `chrome_do_action` 群组，方便管理，群组空了自动清理
- **命令超时**：服务端 60 秒无响应自动报超时，浏览器离线即时通知 CLI

### 6. JS 错误收集

页面加载即开始持久收集 `window.onerror` 与 `unhandledrejection`，不阻塞任何命令。错误持续累积，`get_js_errors` 查看、`clear_js_errors` 清空，也可在任意支持 `--field` 的命令中指定 `jsErrors` 附带返回。错误**跨所有 frame 聚合**，iframe 内的报错也会被收集。

### 7. iframe 读写操作

所有元素命令（`click`/`real_click`/`type`/`get_text`/`get_css`/`show`/`upload_file`/`paste_rich`）都**自动搜索 iframe**：顶层优先、深度优先遍历每个 frame（含跨域），首个命中即为目标，返回中带 `frame: {frameId, url}` 标明命中位置。

```bash
# 读取 iframe 内元素文本（自动搜索到跨域 iframe）
cda send OfficePC get_text current '{"selector":".rich-text-content"}'

# 点击 iframe 内按钮（跨域同样可命中）
cda send OfficePC click current '{"selector":"#save"}'

# 固定到某个 frame：按 URL 子串（跨域最稳）
cda send OfficePC click current '{"selector":"#submit","frame":{"url":"mp.weixin.qq.com"}}'

# 只搜顶层，或按序号指定顶层 iframe
cda send OfficePC get_text current '{"selector":"#nav","frame":"top"}'
cda send OfficePC get_text current '{"selector":"#editor","frame":0}'
```

- **跨域定位原理**：同源 iframe 用 `get_rect` 沿 `window.parent` 链把坐标换算到顶层视口；跨域边界访问父文档抛 SecurityError，自动切换 CDP `DOM.getContentQuads` 取元素在顶层视口的真实中心坐标
- **`real_click` 在 iframe 内同样有效**：同源复用换算坐标，跨域走 CDP 精确定位后发送 `isTrusted=true` 的真实鼠标事件链
- **`frame` 参数**：`"auto"`（缺省，顶层优先全 frame）、`"top"`（仅顶层）、数字（顶层 iframe 序号）、`{url:"子串"}`（URL 匹配首个 frame）
- `get_text` 不带 selector 时仍取顶层整页文本（向后兼容）；`get_page_info --field iframes` 直接看所有 frame 的元数据与内容快照

---

## 返回格式

### `open` / `get_page_info`

```json
{
  "url": "https://example.com",
  "title": "Example Domain",
  "iframes": [
    { "index": 0, "src": "https://ads.example.com", "sameOrigin": false, "url": "https://ads.example.com", "html": "..." },
    { "index": 1, "src": "/embedded", "sameOrigin": true, "url": "/embedded", "html": "..." }
  ]
}
```

所有 iframe 均补全 `url`（当前文档地址）与 `html`（内部内容快照），**跨域 iframe 同样可见**。`src` 为 iframe 标签原始属性，`url` 为 frame 当前地址，二者跨域重定向时可能不同。

### `click`（未跳转）

```json
{
  "navigated": false,
  "clickDesc": { "text": "登录", "tag": "button" },
  "currentTab": { "url": "...", "title": "...", "iframes": [...] },
  "iframeChanges": [],
  "newTabs": []
}
```

- `clickDesc`：本次点击的描述（`text`/`selector`/`x,y` + `tag`）
- `navigated`：是否发生页面跳转；若为 `true`，返回新页面信息（含跳转后 `currentTab`）
- `newTabs`：`target="_blank"` 打开的新标签页（含 tabId、url、title、iframes）
- `iframeChanges`：`[{index, srcChanged, beforeSrc, afterSrc}]`，仅在检测到变化时出现

### 其他命令

| 命令 | 返回 |
|---|---|
| `get_text` | 字符串，如 `"登录"` |
| `get_css` | `{ selector, count, results: [{index, css: {display, …}}] }` |
| `type` / `clear_js_errors` | `{ success: true }` |
| `upload_file` | `{ success: true, data: { filename, size, mime } }` |
| `scroll` | `{ success: true, data: { scrollX, scrollY } }` |
| `get_js_errors` | `{ errors: [{message, source, lineno}], count }` |
| `close_tab` | `{ success: true, data: { tabId } }` |
| `list_tabs` | `[{ id, title, url, active }]` |
| `screenshot` | 本地保存 PNG，打印保存路径与字节数 |

---

## 通信协议

所有消息为 JSON，经 WebSocket 传输。协议极简，三条消息核心往返：

| 消息 | 方向 | 作用 |
|---|---|---|
| `register` / `register_ack` | 扩展 ↔ 服务端 | 浏览器注册节点，服务端分配 `nodeId` |
| `command` / `command_result` | 服务端 ↔ 扩展 | 指令与结果（携带 `commandId` 关联） |
| `cli` / `cli_result` | CLI ↔ 服务端 | 命令行请求与应答 |

每条消息带唯一 `id` 用于请求-响应关联；`ping`/`pong` 每 30 秒保活。任何语言只要遵循这套 JSON 协议，都可以充当 CLI 那一端。

---

## 故障排查

| 现象 | 处理 |
|---|---|
| `cda list` 为空 / 报错 | 服务端未启动或地址不对；浏览器扩展是否已连接（图标 ✕ = 未连接） |
| `Client "xxx" not found` | 目标节点不在线，先 `cda list` 确认 |
| `no content script loaded` | 页面是 `chrome://` 页或未加载完；扩展更新后需在 `chrome://extensions` 刷新并重载页面 |
| 点击元素提示 `No active tab` | 当前窗口没有可用标签页 |
| 扩展连不上 | 打开 `chrome://extensions` → 点击该扩展的「service worker」查看日志 |
| 命令无响应 | 查看服务端 `--log-dir` 日志，追踪 `[connect]`/`[send]`/`[result]` 链路 |

---

## License

[MIT](LICENSE) © 2026 kiki

---

*用爱发电的浏览器遥控器。有真实浏览器操作需求时，试试 `cda`。*
