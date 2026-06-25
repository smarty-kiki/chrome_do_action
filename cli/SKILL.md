# chrome-do-action

远程控制 Chrome 浏览器执行页面操作：打开页面、点击元素、输入文本、提取内容、监听 JS 错误。通过一条命令即可完成，无需编写脚本。

## 前提

服务端和 Chrome 扩展需要先启动并连接：

```bash
# 1. 启动服务端
node dist/server.js --port 12345 --log-dir /tmp/chrome/

# 2. Chrome 加载扩展（chrome-extension/dist/），在弹出窗填写服务端地址
```

确认浏览器已在线：

```bash
chrome-do-action --server ws://127.0.0.1:12345 list
```

返回类似 `OfficePC  Chrome  192.168.1.5  online 123s`，记下节点名称（如 `OfficePC`），后续命令用它指定目标浏览器。

## 返回结构

### open 返回

```json
{
  "url": "http://example.com",
  "title": "页面标题",
  "iframes": [
    { "index": 0, "src": "...", "sameOrigin": true, "url": "..." }
  ]
}
```

### click 返回

点击后返回以下字段，根据操作结果动态组装：

| 字段 | 类型 | 说明 |
|------|------|------|
| `navigated` | boolean | 当前标签页是否发生了跳转 |
| `clickDesc` | object | 点击描述（`selector`/`text`/`x,y` + `tag`） |
| `currentTab` | object | 当前标签页信息（`url`、`title`、`iframes`） |
| `newTabs` | array | 新打开的标签页列表（每个包含 `tabId`、`url`、`title`、`iframes`） |
| `iframeChanges` | array | iframe 变化列表，仅在检测到变化时出现 |

`currentTab` 和 `newTabs` 中的 `iframes` 是该页面当前的 iframe 列表，结构同 `open` 的 `iframes`。

### iframeChanges

每个变化项：

```json
{
  "index": 0,
  "srcChanged": true,
  "beforeSrc": "https://a.com",
  "afterSrc": "https://b.com"
}
```

通过 `index` 定位 iframe 在页面中的序号，`srcChanged` 和前后 `src` 描述具体变化。没有变化时 `iframeChanges` 不会出现在返回中。

### newTabs

点击 `target="_blank"` 的链接时，新标签页信息：

```json
{
  "tabId": 1020842254,
  "url": "http://example.com/new",
  "title": "新页面",
  "iframes": []
}
```

## _field 过滤

通过 `--field` 指定需要的字段，减少不必要的 DOM 操作。

### 支持的字段路径

| 字段 | 说明 |
|------|------|
| `currentTab` | 当前标签页完整信息（url、title、iframes） |
| `currentTab.url` | 仅 url |
| `currentTab.title` | 仅 title |
| `currentTab.iframes` | 仅 iframe 列表 |
| `newTabs` | 新标签页完整信息（含 iframes） |
| `iframeChanges` | 仅返回 iframe 变化数组 |

### 使用示例

```bash
# 只看当前页 url
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC click current '{"selector":"#submit"}' --field "currentTab.url"

# 只看新标签页
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC click current '{"text":"打开"}' --field "newTabs"

# 只看 iframe 变化
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC click current '{"selector":"#refresh"}' --field "iframeChanges"
```

## 常用场景

### 打开页面并确认加载成功

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC open https://example.com
```

返回页面 url、title 和 iframe 列表。需要只看 URL 和标题：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC open https://example.com --field "currentTab.url,currentTab.title"
```

### 登录表单（type + click）

两步操作，先输入账号密码，再点击登录按钮：

```bash
# 点击聚焦用户名输入框并输入
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC click current '{"selector":"#username"}'
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC type current '{"selector":"#username","text":"admin"}'

# 点击聚焦密码输入框并输入
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC click current '{"selector":"#password"}'
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC type current '{"selector":"#password","text":"secret"}'

# 点击登录
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC click current '{"text":"登录"}'
```

点击登录后如果页面跳转，返回中 `navigated: true`，并包含新页面的 `currentTab` 信息。如果弹出了新标签页，返回中会出现 `newTabs` 数组。

只看登录后跳转到了哪个 URL：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC click current '{"text":"登录"}' --field "currentTab.url,navigated"
```

### 提取页面内容

按文字查找按钮并获取页面文本：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC click current '{"text":"提交"}'
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC get_text current
```

获取特定元素的文本：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC get_text current '{"selector":".result"}'
```

提取后通过管道传给其他工具处理：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC get_text current '{"selector":"#price"}' | xargs echo "价格："
```

### 滚动加载长页面

滚动到底部等待内容加载（如懒加载的列表）：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC scroll current '{"y": 99999}'
```

滚动后等 DOM 稳定再返回，适合配合 `get_text` 提取新加载的内容。

### 监听 JS 错误

打开页面后检查是否有前端报错：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC open https://example.com
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC get_js_errors current
```

返回 `{ errors: [...], count: N }`，每条错误包含 `message`、`source`（文件名）、`lineno`（行号）。

查看错误后清空，方便下一次操作重新计数：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC clear_js_errors current
```

### 管理标签页

查看当前所有标签页：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC list_tabs
```

关闭指定标签页，`current` 表示当前活跃页：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC close_tab current
```

也可传入数字 tabId 关闭非活跃页：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC close_tab 456
```

刷新指定标签页，`current` 表示当前活跃页：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC refresh current
```

也可传入数字 tabId 刷新非活跃页：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC refresh 456
```

刷新后等待页面完全加载再返回，配合 `get_page_info` 确认加载结果：

```bash
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC refresh current
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC get_page_info current
```

### 组合场景：抓取表格数据

```bash
# 打开页面
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC open https://example.com/data

# 滚动到底部加载全部数据
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC scroll current '{"y": 99999}'

# 提取表格文本
chrome-do-action --server ws://127.0.0.1:12345 send OfficePC get_text current '{"selector":"table"}'
```

## 命令速查

所有页面命令都需要指定标签页（`current` 或数字 tabId），浏览器命令不需要。

### 浏览器命令

| 命令 | 用法 | 说明 |
|------|------|------|
| `open <url>` | `send <id> open <url>` | 打开新标签页，等待加载完成 |
| `list_tabs` | `send <id> list_tabs` | 列出所有标签页 |
| `close_tab <id>` | `send <id> close_tab current` | 关闭标签页 |
| `refresh <id>` | `send <id> refresh current` | 刷新标签页，等待加载完成 |

### 页面命令

| 命令 | 用法 | 说明 |
|------|------|------|
| `click` | `send <id> click <tab> <params>` | 点击元素 |
| `type` | `send <id> type <tab> <params>` | 输入文本 |
| `get_text` | `send <id> get_text <tab> [selector]` | 获取文本内容 |
| `get_css` | `send <id> get_css <tab> <selector>` | 获取所有匹配元素的 computed style，返回 `{selector, count, results}` |
| `get_page_info` | `send <id> get_page_info <tab> [--field ...]` | 获取页面信息 |
| `get_js_errors` | `send <id> get_js_errors <tab>` | 获取 JS 错误 |
| `clear_js_errors` | `send <id> clear_js_errors <tab>` | 清空 JS 错误 |
| `scroll` | `send <id> scroll <tab> <params>` | 滚动页面 |

### click 定位方式

```json
{"selector": "#submit"}              // CSS 选择器
{"text": "登录"}                      // 按可见文字查找（优先按钮/链接）
{"x": 100, "y": 200}                 // 坐标点击
{"selector": "css:button"}           // 显式 CSS 前缀
{"selector": "xpath://btn"}          // XPath 前缀
```

### scroll 参数

```json
{"y": 500}                   // 垂直滚动
{"x": 300, "y": 500}         // 水平 + 垂直
```

## 注意事项

- `text` 定位会跳过 `<script>`、`<style>`、`<noscript>` 等不可见元素，优先匹配 `<button>`、`<a>`、`<input>`
- `--field` 只对 `click`、`get_page_info`、`open` 有效，在浏览器端按需采集，减少不必要的 DOM 操作
- `--field html` 会被 Content Script 采集但被服务端剥离，不会出现在返回中；如需页面 HTML 内容，用 `get_text` 配合 selector 获取
- 同一标签页的命令串行执行，前一条完成后下一条才执行，不需要手动等待
- 点击后如果页面跳转，会自动等待新页面加载完成再返回结果
