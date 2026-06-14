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
# 打开新标签页（等待完全加载后返回）
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

- 成功时输出 JSON 数据（字符串直接输出）
- 失败时输出 `Error: <message>` 并退出码 1
- list 命令以表格形式输出客户端列表
- 命令会等待浏览器执行完成才返回（包括页面加载等待）

## 常用流程

```bash
# 1. 查看在线客户端
chrome-do-action --server ws://127.0.0.1:12345 list
# → abc123  MyChrome  192.168.1.5  online 120s

# 2. 查看当前页面信息
chrome-do-action --server ws://127.0.0.1:12345 send abc123 get_title current
chrome-do-action --server ws://127.0.0.1:12345 send abc123 get_url current

# 3. 点击"登录"按钮（按文字查找）并等待页面跳转完成
chrome-do-action --server ws://127.0.0.1:12345 send abc123 click current '{"text":"登录"}'
# → {"success":true,"navigated":true,"url":"https://example.com/dashboard","title":"Dashboard"}

# 4. 打开新页面
chrome-do-action --server ws://127.0.0.1:12345 send abc123 open https://github.com
```
