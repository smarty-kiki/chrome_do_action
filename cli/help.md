# cda

远程控制 Chrome 浏览器执行页面操作：打开页面、点击元素、输入文本、提取内容、监听 JS 错误。通过一条命令即可完成，无需编写脚本。

## 前提

服务端和 Chrome 扩展需要先启动并连接：

```bash
# 1. 启动服务端
node dist/server.js --port 12345 --log-dir /tmp/chrome/

# 2. Chrome 加载扩展（chrome-extension/dist/），在弹出窗填写服务端地址
```

`--server` 默认为 `ws://127.0.0.1:12345`，本地运行时可省略。

确认浏览器已在线：

```bash
cda list
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
cda --server ws://127.0.0.1:12345 send OfficePC click current '{"selector":"#submit"}' --field "currentTab.url"

# 只看新标签页
cda --server ws://127.0.0.1:12345 send OfficePC click current '{"text":"打开"}' --field "newTabs"

# 只看 iframe 变化
cda --server ws://127.0.0.1:12345 send OfficePC click current '{"selector":"#refresh"}' --field "iframeChanges"
```

## 常用场景

### 打开页面并确认加载成功

```bash
cda send OfficePC open https://example.com
```

返回页面 url、title 和 iframe 列表。需要只看 URL 和标题：

```bash
cda send OfficePC open https://example.com --field "currentTab.url,currentTab.title"
```

### 登录表单（type + click）

两步操作，先输入账号密码，再点击登录按钮：

```bash
# 点击聚焦用户名输入框并输入
cda send OfficePC click current '{"selector":"#username"}'
cda send OfficePC type current '{"selector":"#username","text":"admin"}'

# 点击聚焦密码输入框并输入
cda send OfficePC click current '{"selector":"#password"}'
cda send OfficePC type current '{"selector":"#password","text":"secret"}'

# 点击登录
cda send OfficePC click current '{"text":"登录"}'
```

点击登录后如果页面跳转，返回中 `navigated: true`，并包含新页面的 `currentTab` 信息。如果弹出了新标签页，返回中会出现 `newTabs` 数组。

只看登录后跳转到了哪个 URL：

```bash
cda send OfficePC click current '{"text":"登录"}' --field "currentTab.url,navigated"
```

### 富文本编辑器输入（公众号/后台系统）

富文本编辑器（ProseMirror、UEditor 等 contenteditable）直接用 type 输入，按换行自动分段：

```bash
cda send OfficePC click current '{"selector":".ProseMirror"}'
cda send OfficePC type current '{"selector":".ProseMirror","text":"第一段内容。\n\n第二段内容。"}'
```

注意：一次传入完整内容，不要分多次 type 追加（会覆盖）。

### 图片上传（file input）

向页面的 file input 注入 base64 图片，触发页面上传逻辑：

```bash
# 图片先压缩并转 base64（macOS 示例）
sips -z 383 900 cover.png --out cover.jpg
B64=$(base64 -i cover.jpg | tr -d '\n')

cda send OfficePC upload_file current "{\"selector\":\"input[type=file]\",\"base64\":\"$B64\",\"filename\":\"cover.jpg\",\"mime\":\"image/jpeg\"}"
```

适用于无法操作系统文件对话框的场景（如无辅助功能权限时上传公众号封面）。

### 提取页面内容

按文字查找按钮并获取页面文本：

```bash
cda send OfficePC click current '{"text":"提交"}'
cda send OfficePC get_text current
```

获取特定元素的文本：

```bash
cda send OfficePC get_text current '{"selector":".result"}'
```

提取后通过管道传给其他工具处理：

```bash
cda send OfficePC get_text current '{"selector":"#price"}' | xargs echo "价格："
```

### 滚动加载长页面

滚动到底部等待内容加载（如懒加载的列表）：

```bash
cda send OfficePC scroll current '{"y": 99999}'
```

滚动后等 DOM 稳定再返回，适合配合 `get_text` 提取新加载的内容。

### 监听 JS 错误

打开页面后检查是否有前端报错：

```bash
cda send OfficePC open https://example.com
cda send OfficePC get_js_errors current
```

返回 `{ errors: [...], count: N }`，每条错误包含 `message`、`source`（文件名）、`lineno`（行号）。

查看错误后清空，方便下一次操作重新计数：

```bash
cda send OfficePC clear_js_errors current
```

### 管理标签页

查看当前所有标签页：

```bash
cda send OfficePC list_tabs
```

关闭指定标签页，`current` 表示当前活跃页：

```bash
cda send OfficePC close_tab current
```

也可传入数字 tabId 关闭非活跃页：

```bash
cda send OfficePC close_tab 456
```

刷新指定标签页，`current` 表示当前活跃页：

```bash
cda send OfficePC refresh current
```

也可传入数字 tabId 刷新非活跃页：

```bash
cda send OfficePC refresh 456
```

刷新后等待页面完全加载再返回，配合 `get_page_info` 确认加载结果：

```bash
cda send OfficePC refresh current
cda send OfficePC get_page_info current
```

### 组合场景：抓取表格数据

```bash
# 打开页面
cda send OfficePC open https://example.com/data

# 滚动到底部加载全部数据
cda send OfficePC scroll current '{"y": 99999}'

# 提取表格文本
cda send OfficePC get_text current '{"selector":"table"}'
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
| `click` | `send <id> click <tab> <params>` | 点击元素（合成事件） |
| `real_click` | `send <id> real_click <tab> <params>` | 真实点击（CDP，isTrusted=true），参数 {selector} 或 {x,y}，可选 {approach} 渐进移动路径；用于合成事件无效的站点（如微信后台）及 hover 工具条 |
| `type` | `send <id> type <tab> <params>` | 输入文本（{selector,text}），支持 input/textarea 与 contenteditable 富文本，富文本按换行分段 |
| `upload_file` | `send <id> upload_file <tab> <params>` | 向 file input 注入本地图片（{selector,base64,filename,mime}），触发 change 事件完成上传 |
| `paste_rich` | `send <id> paste_rich <tab> <params>` | 向 contenteditable 富文本编辑器粘贴带样式的 HTML（{selector,html}），等价于粘贴排好版的文档 |
| `show` | `send <id> show <tab> <params>` | 强制显示隐藏元素（{selector}），仅改 CSS 样式不执行代码；让 hover 才显示的菜单/工具条常驻可见，随后可被 click 命中 |
| `get_text` | `send <id> get_text <tab> [selector]` | 获取文本内容 |
| `get_css` | `send <id> get_css <tab> <selector>` | 获取所有匹配元素的 computed style，返回 `{selector, count, results}` |
| `get_page_info` | `send <id> get_page_info <tab> [--field ...]` | 获取页面信息 |
| `get_js_errors` | `send <id> get_js_errors <tab>` | 获取 JS 错误 |
| `clear_js_errors` | `send <id> clear_js_errors <tab>` | 清空 JS 错误 |
| `screenshot` | `send <id> screenshot <tab> <params>` | CDP 截图当前页面（只读，不注入代码）；`{"path":"/tmp/shot.png"}` 保存到本地 |
| `scroll` | `send <id> scroll <tab> <params>` | 滚动页面 |

### click 定位方式

```json
{"selector": "#submit"}              // CSS 选择器
{"text": "登录"}                      // 按可见文字查找（优先按钮/链接）
{"x": 100, "y": 200}                 // 坐标点击
{"selector": "css:button"}           // 显式 CSS 前缀
{"selector": "xpath://btn"}          // XPath 前缀
```

### real_click

- 与 `click` 参数基本相同（selector 或 x/y），但通过 chrome.debugger（CDP）发送**完整真实鼠标事件链**（isTrusted=true）
- 事件链：`mouseMoved`（触发 mouseover/mouseenter，激活 hover 状态）→ `mousePressed`(mousedown+focus) → `mouseReleased`(mouseup，浏览器自动合成 click)
- 鼠标移动采用**渐进步进**（每步 10px）而非瞬移，能真实触发途经元素的 hover 链；点击后鼠标**停留在目标上**，保持 hover 状态供连续操作
- **approach 参数**：模拟"先移到触发点、再移到目标"的多级 hover 场景（如微信封面 hover 工具条：先移向封面按钮，再点击工具条里的菜单项）
  ```json
  // 先渐进经过封面按钮（触发 hover 菜单），最后点击"从图片库选择"菜单项
  {"x": 500, "y": 343, "approach": [[360, 360], [420, 330], [470, 325]]}
  ```
- 原理：content script 获取元素中心坐标（或直接给 x/y）→ 激活窗口 → CDP `Input.dispatchMouseEvent` 发送完整序列
- 适用：对合成事件免疫的站点（如微信公众平台后台 Vue 组件）、hover 才显示的工具条元素
- 注意：**坐标必须是元素真实位置**（用截图确认），DOM 快照里可能有顶部隐藏模板导致 get_rect 返回错误坐标（如把 y=824 误报成 y=224）
- 副作用：attach 瞬间 Chrome 顶部会出现"正在调试此浏览器"横幅，随即消失
- 使用：`send <id> real_click <tab> '{"selector":"#submit"}'` 或 `'{"x":100,"y":200}'`

### type 参数

```json
{"selector": "#username", "text": "admin"}     // input/textarea：直接设置 value
{"selector": ".ProseMirror", "text": "第一段\n\n第二段"}  // contenteditable：按换行分段插入
```

- input/textarea：设置 `value` 并触发 `input` + `change` 事件
- contenteditable（如 ProseMirror 富文本）：聚焦后按 `\n` 分段插入，保留段落结构；一次调用传入完整内容，不要多次追加（会覆盖）

### upload_file 参数

```json
{"selector": "input[type=file]", "base64": "<base64内容>", "filename": "cover.jpg", "mime": "image/jpeg"}
```

- 将 base64 图片注入 file input 并触发 `change` 事件，页面监听到后自动上传
- 适用于无法手动操作系统文件对话框的场景（如无辅助功能权限时上传公众号封面）
- 图片建议先压缩（如 900x383 JPEG、<100KB），避免 base64 过大

### paste_rich 参数

```json
{"selector": ".ProseMirror", "html": "<section style=\"text-align:center\"><span style=\"font-weight:bold;font-size:17px\">小标题</span></section>"}
```

- 向 contenteditable 富文本编辑器（ProseMirror、UEditor 等）粘贴带内联样式的 HTML，保留字号/颜色/加粗/间距等格式
- 会先清空目标编辑器现有内容再插入（等价于"全选删除后粘贴"）
- 与 `type`（纯文本）互补：type 写字，paste_rich 粘贴排版
- 不修改页面源代码，仅向编辑器内容区插入富文本

### show

```
send <id> show <tabId> '.js_imagedialog'      // selector 直接位置参数
```

- **只改 CSS 样式，不执行代码**：将所有匹配元素的 `visibility` 置为 `visible`、`opacity` 置为 `1`、`display` 若为 `none` 则置为 `block`
- **默认作用于所有匹配元素**（无需 all 参数）
- inline style 优先级最高，不会被 hover CSS 覆盖 → 元素**常驻可见**
- 用途：hover 才显示的工具条/菜单（如微信后台封面菜单"从图片库选择"等），强制显示后可被 `click` 或 `real_click` 命中
- 组合用法：`show` 显示菜单项 → `click`（或 `real_click`）点击 → 后续流程 → `hide` 还原

### hide

```
send <id> hide <tabId>       // 无参数：还原全部被 show 的元素
```

- 与 `show` 成对：操作完调用 hide 还原，清掉 inline style 回到 CSS 控制，避免菜单常驻影响后续点击
- show 会记录被改元素的原始 inline 样式，hide 精确恢复
- 页面刷新后样式本身恢复原状（inline style 不持久），hide 用于不刷新页面的场景

### scroll 参数

```json
{"y": 500}                   // 垂直滚动
{"x": 300, "y": 500}         // 水平 + 垂直
```

### screenshot

```json
{"path": "/tmp/shot.png"}    // 截图保存路径（默认 screenshot.png）
```

- 通过 CDP `Page.captureScreenshot` 截取当前标签页（PNG），返回 base64，CLI 自动解码保存到 `path`
- 只读能力（等同 DevTools 截图），不注入代码、不修改页面
- 用于确认页面真实视觉状态（元素遮挡、浮层、滚动位置），避免仅凭 DOM 快照盲猜坐标
- 适用：操作前确认页面状态、排查点击无响应（如浮层遮罩挡住目标元素）

## 注意事项

- `text` 定位会跳过 `<script>`、`<style>`、`<noscript>` 等不可见元素，优先匹配 `<button>`、`<a>`、`<input>`
- `--field` 只对 `click`、`get_page_info`、`open` 有效，在浏览器端按需采集，减少不必要的 DOM 操作
- `--field html` 会被 Content Script 采集但被服务端剥离，不会出现在返回中；如需页面 HTML 内容，用 `get_text` 配合 selector 获取
- 同一标签页的命令串行执行，前一条完成后下一条才执行，不需要手动等待
- 点击后如果页面跳转，会自动等待新页面加载完成再返回结果
- `get_text` 对 textarea 返回空（textContent 不含 value），验证 textarea 输入用 `get_page_info --field "currentTab.html"` 抓 HTML 检查
- 扩展更新代码后需在 `chrome://extensions` 刷新扩展，且已打开页面需刷新才会重新注入新脚本
