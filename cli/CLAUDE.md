# chrome-do-action CLI

命令行工具，通过 WebSocket 连接服务端，向浏览器扩展发送远程控制命令。

## 运行方式

```bash
chrome-do-action --server ws://127.0.0.1:12345 <action> [args...]
```

## 命令

### list — 列出已连接的客户端

```bash
chrome-do-action --server ws://127.0.0.1:12345 list
# 输出：
# abc123  MyChrome  192.168.1.5  online 120s
# def456  OfficePC  10.0.0.2     online 45s
```

### send — 向指定客户端发送命令

格式：`send <nodeId> <command> [tabId] [params]`

**浏览器命令（无需 tab）：**

```bash
# 打开新标签页（加入 chrome_do_action 群组，等待加载完成后返回完整页面信息）
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> open https://example.com

# 列出所有标签页
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> list_tabs

# 关闭标签页
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> close_tab current
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> close_tab 456
```

**页面命令（需要 tab，用 current 或数字 tabId）：**

```bash
# 获取页面标题
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_title current

# 获取页面 URL
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_url current

# 获取页面文本
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_text current
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_text current '{"selector":"#main"}'

# 获取渲染后的 HTML
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_html current
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> get_html current '{"selector":"#content"}'

# 点击（三种方式）
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> click current '{"selector":"#submit"}'
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> click current '{"text":"登录"}'
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> click current '{"x":100,"y":200}'

# 输入文本
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> type current '{"selector":"#name","text":"hello"}'

# 滚动页面
chrome-do-action --server ws://127.0.0.1:12345 send <nodeId> scroll current '{"y":500}'
```

## 返回结果

- 成功时输出 JSON 数据
- 失败时输出 `Error: <message>` 并退出码 1
- list 命令以表格形式输出客户端列表
- 命令会等待浏览器执行完成才返回（包括页面加载等待）

### open 返回

页面和所有 iframe 加载完成后返回，包含完整页面信息和 JS 错误列表。

```json
{
  "url": "https://example.com",
  "title": "Example Domain",
  "html": "<!DOCTYPE html>...",
  "iframes": [
    {
      "index": 0,
      "src": "https://ads.example.com",
      "sameOrigin": false
    },
    {
      "index": 1,
      "src": "/embedded",
      "sameOrigin": true,
      "url": "/embedded",
      "html": "<html><body>...</body></html>"
    }
  ],
  "jsErrors": []
}
```

### click 返回（不跳转）

点击后返回点击描述 + 当前页面完整信息 + iframe 变化对比 + JS 错误。

```json
{
  "success": true,
  "navigated": false,
  "data": {
    "selector": "#load-report",
    "current": {
      "url": "https://example.com",
      "title": "Example",
      "html": "<!DOCTYPE html>...",
      "iframes": [...]
    },
    "iframeChanged": true,
    "iframeChanges": [
      {
        "index": 1,
        "srcChanged": false,
        "htmlChanged": true,
        "beforeSrc": "/report-old",
        "afterSrc": "/report-new"
      }
    ],
    "jsErrors": []
  }
}
```

### click 返回（页面跳转 / 新标签页）

点击导致页面导航或 target="_blank" 打开新标签页时返回。包含原页面和新页面的完整信息。

```json
{
  "success": true,
  "navigated": true,
  "data": {
    "current": {
      "url": "https://example.com/dashboard",
      "title": "Dashboard",
      "html": "...",
      "iframes": [...]
    },
    "newTabs": [
      {
        "tabId": 456,
        "url": "https://example.com/popped-up",
        "title": "Popped Up",
        "html": "...",
        "iframes": [...]
      }
    ]
  }
}
```

### 其他页面命令返回

直接返回原始结果，不附带额外包装：

- `get_title` → `"Example Domain"`（字符串）
- `get_text` → `"登录"`（字符串）
- `get_url` → `"https://example.com"`（字符串）
- `get_html` → `"<!DOCTYPE html>..."`（字符串）
- `type` → `{ "success": true }`（对象）
- `scroll` → `{ "success": true, "data": { "scrollY": 500 } }`（对象）

## 常用流程

```bash
# 1. 查看在线客户端
chrome-do-action --server ws://127.0.0.1:12345 list
# → abc123  MyChrome  192.168.1.5  online 120s

# 2. 查看当前页面信息
chrome-do-action --server ws://127.0.0.1:12345 send abc123 get_title current
chrome-do-action --server ws://127.0.0.1:12345 send abc123 get_url current

# 3. 点击"登录"按钮（按文字查找），返回页面状态和 iframe 变化
chrome-do-action --server ws://127.0.0.1:12345 send abc123 click current '{"text":"登录"}'
# → {"success":true,"navigated":false,"data":{"selector":"...","current":{...},"iframeChanged":true,...}}

# 4. 点击后页面跳转，等待新页面加载完成
chrome-do-action --server ws://127.0.0.1:12345 send abc123 click current '{"text":"登录"}'
# → {"success":true,"navigated":true,"data":{"current":{...},"newTabs":[]}}

# 5. 打开新页面
chrome-do-action --server ws://127.0.0.1:12345 send abc123 open https://github.com
```
