# cda

远程控制 Chrome 浏览器执行页面操作：打开页面、点击元素、输入文本、触发事件、提取内容、监听 JS 错误。通过一条命令即可完成，无需编写脚本。

## 前提

服务端和 Chrome 扩展需要先启动并连接：

```bash
# 1. 启动服务端
node server/dist/server.js --port 12345 --log-dir /tmp/chrome/

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
    { "index": 0, "src": "/embedded", "sameOrigin": true, "url": "/embedded", "html": "..." },
    { "index": 1, "src": "https://ads.example.com", "sameOrigin": false, "url": "https://ads.example.com", "html": "..." }
  ]
}
```

`iframes` 中**同源与跨域 iframe 都补全 `url` 与 `html`**。`src` 为 iframe 标签的原始属性，`url` 为 frame 当前文档地址（跨域也可获取）。

### click 返回

点击后返回以下字段，根据操作结果动态组装：

| 字段 | 类型 | 说明 |
|------|------|------|
| `navigated` | boolean | 当前标签页是否发生了跳转 |
| `clickDesc` | object | 点击描述（`selector`/`text`/`x,y` + `tag`） |
| `settledMs` | number | 等影响落地的耗时（毫秒），见「等影响落地」 |
| `currentTab` | object | 当前标签页信息（`url`、`title`、`iframes`） |
| `newTabs` | array | 新打开的标签页列表（每个包含 `tabId`、`url`、`title`、`iframes`） |
| `iframeChanges` | array | iframe 变化列表，仅在检测到变化时出现 |
| `waitFor` | object | 传入 `waitFor` 参数时的等待结果（`settled` + `waited`） |

`currentTab` 和 `newTabs` 中的 `iframes` 是该页面当前的 iframe 列表，结构同 `open` 的 `iframes`。

### 等影响落地（settle）

`click`/`type`/`keyboard`/`trigger`/`upload_file`/`upload_dragdrop`/`paste_rich`/`scroll`/`real_click` 返回前会**等动作的影响落地**——事件驱动（DOM 变化 + 长任务检测），不是固定 sleep：

- **无影响动作**（点击无副作用元素）：约 0.6s 返回（600ms 活动窗口 + 静默确认）
- **有影响动作**（异步渲染、debounce 重排）：等到 DOM 安静 250ms 后返回，`settledMs` 如实反映等待耗时
- **影响落地晚于检测窗口**（服务端请求响应后才渲染、长 debounce）→ 传 `waitFor` 谓词：

```json
{"selector": "#toast", "waitFor": {"selector": "#success-toast"}}
{"text": "登录", "waitFor": {"text": "发布成功"}}
```

`waitFor` 以 50ms 间隔轮询条件（元素存在且可见 / 可见文本），**条件满足的瞬间返回**（不是等满超时）：`{"settled": true, "waited": 615}`；3s 超时未满足返回 `{"settled": false}`（动作本身已成功，仅影响未确认）。

**后台标签页**：Chrome 对不可见 tab 会节流——settle 可能偏慢（无影响动作约 1.6s 返回），深度后台下影响可能等不到，此时用 `waitFor` 谓词（轮询不受节流）或把 tab 切到前台。

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

通过 `--field` 指定需要的字段，精确裁剪返回结果。**所有返回对象的命令**都支持（click/type/keyboard/trigger/upload_file/upload_dragdrop/paste_rich/scroll/show/hide/get_css/get_page_info/get_js_errors/real_click/open/refresh/close_tab），点路径逐段投影、保留嵌套形状：

- `--field a` → `{a: 完整值}`
- `--field a.b` → `{a: {b: 值}}`（脚本 `res.a.b` 恒可读）
- `--field arr.k`（arr 为数组）→ `{arr: [k1, k2, ...]}`
- 不存在的路径忽略，不报错；无 `--field` 时返回全量
- `get_text` 返回纯文本字符串（单一结果，无字段可滤）

### 常用字段路径

| 字段 | 说明 |
|------|------|
| `clickDesc.selector` / `clickDesc.text` / `clickDesc.tag` | 点击命中的元素 |
| `settledMs` | 等影响落地耗时 |
| `navigated` | 是否发生导航 |
| `currentTab` | 当前标签页完整信息（url、title、iframes） |
| `currentTab.url` | 仅 url |
| `currentTab.iframes` | 仅 iframe 列表 |
| `frame.url` | 元素命中的 frame |
| `newTabs` | 新标签页完整信息（含 iframes） |
| `newTabs.url` | 各新标签页的 url 数组 |
| `iframeChanges` | 仅返回 iframe 变化数组 |
| `count` | show/hide/get_css/get_js_errors 的计数 |
| `x` / `y` / `trusted` | real_click 的点击坐标与可信标记 |
| `url` / `title` | open/get_page_info 的页面信息 |

### 使用示例

```bash
# 点完只要命中元素 + 耗时
cda --server ws://127.0.0.1:12345 send OfficePC click current '{"selector":"#submit"}' --field "clickDesc.selector,settledMs"

# 只看当前页 url
cda --server ws://127.0.0.1:12345 send OfficePC click current '{"selector":"#submit"}' --field "currentTab.url"

# 只看新标签页的 url
cda --server ws://127.0.0.1:12345 send OfficePC click current '{"text":"打开"}' --field "newTabs.url"

# 只看 iframe 变化
cda --server ws://127.0.0.1:12345 send OfficePC click current '{"selector":"#refresh"}' --field "iframeChanges"

# 输入后只看耗时
cda --server ws://127.0.0.1:12345 send OfficePC type current '{"selector":"#title","text":"hi"}' --field "settledMs"
```

## iframe 定位

元素命令（`click`/`real_click`/`type`/`keyboard`/`trigger`/`get_text`/`get_css`/`show`/`upload_file`/`upload_dragdrop`/`paste_rich`）**默认自动搜索 iframe**：先顶层 frame，再按深度优先逐个查找所有 iframe（含跨域），首个命中的 frame 即为目标，返回中带 `frame: {frameId, url}` 标明命中位置。

如需指定 frame，加 `frame` 参数：

```json
{"selector": ".ProseMirror"}                     // 缺省 = 顶层优先全 frame 自动搜索
{"selector": "#submit", "frame": "top"}          // 仅顶层 frame
{"selector": "#submit", "frame": 0}              // 第 0 个顶层 iframe（按序号）
{"selector": "#submit", "frame": {"url": "mp.weixin.qq.com"}}  // URL 含子串的首个 frame（跨域最稳）
```

- `frame` 支持 `click`/`real_click`/`type`/`keyboard`/`trigger`/`get_text`/`get_css`/`show`/`upload_file`/`upload_dragdrop`/`paste_rich`
- **跨域 iframe 同样可读可操作**：元素命令自动搜索所有 frame，跨域 iframe 同样能定位命中
- `real_click` 在 iframe 内同样可用（含跨域）
- `get_text` 不带 selector 时仍取顶层整页文本（向后兼容）；要读 iframe 文本用 `{"selector":"...","frame":{...}}`

## shadow DOM 定位

Web Components 站点（小红书创作后台等）把按钮/编辑器包在 shadow root 里，普通选择器、XPath 无法穿透。元素命令（`click`/`real_click`/`type`/`keyboard`/`trigger`/`get_text`/`get_css`/`show`/`upload_file`/`upload_dragdrop`/`paste_rich`）默认**透明穿透 open shadow root**，三种方式从显式到隐式：

1. **路径标记 `#shadow-root`**：直接粘贴 DevTools 元素面板「Copy → Copy element path」复制的完整路径（原生 `querySelector` 就是这么写的）：

   ```json
   {"selector": "xhs-publish-btn > #shadow-root > div > div.publish-page-publish-btn > button.ce-btn"}
   ```

2. **`>>>` 组合器**：穿透所有 shadow 层级（Playwright 风格，浏览器原生不支持，这里自行实现）：

   ```json
   {"selector": "xhs-publish-btn >>> button"}
   ```

3. **裸选择器自动兜底**：light DOM 未命中时，按文档序自动搜索所有 open shadow root（含嵌套）；`xpath:` 与 `text` 查找同样兜底到 shadow tree 内（`//` 相对 shadow root 展开，shadow tree 里没有 body）：

   ```json
   {"selector": "button.ce-btn"}
   {"selector": "xpath://button[contains(.,'发布')]"}
   {"text": "发布"}
   ```

- **限制：closed shadow root 无法访问**，元素命令一律返回 notFound；此时用坐标点击兜底：`real_click {"x":..., "y":...}`。
- `get_page_info --field html` 的 html **默认包含 shadow DOM 内容**：open shadow root 以内联 `<template shadowrootmode="open">` 形式出现在宿主元素里；无 shadow 的页面输出与之前完全一致。

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

### 表单校验与下拉选择（trigger）

Element UI / Ant Design 等表单在 `blur` 上触发校验：`type` 输入后字段从未失焦，直接点提交常被校验拦截。输入后主动触发 blur，再点提交：

```bash
cda send OfficePC type current '{"selector":"#username","text":"admin"}'
cda send OfficePC trigger current '{"selector":"#username","event":"blur"}'
cda send OfficePC trigger current '{"selector":"#category","event":"change","value":"2"}'
cda send OfficePC click current '{"text":"提交"}'
```

下拉框选中：`value` 设选项值 + `change` 事件一次完成，React 受控组件同样生效。

### 富文本编辑器输入（公众号/后台系统）

富文本编辑器（ProseMirror、UEditor 等 contenteditable）直接用 type 输入，按换行自动分段：

```bash
cda send OfficePC click current '{"selector":".ProseMirror"}'
cda send OfficePC type current '{"selector":".ProseMirror","text":"第一段内容。\n\n第二段内容。"}'
```

`mode` 可选（默认 `replace` 清空原内容后写入）：`append` 追加到末尾、`insert` 在光标处插入（有选中则替换选区），可用于分多次追加：

```bash
cda send OfficePC type current '{"selector":".ProseMirror","mode":"append","text":"追加的段落。"}'
```

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

返回 `{ errors: [...], count: N }`，每条错误包含 `message`、`source`（文件名）、`lineno`（行号）。错误**跨所有 frame 聚合**，iframe 里的报错也会收集到。

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
| `real_click` | `send <id> real_click <tab> <params>` | 真实点击（对忽略合成事件的站点有效），参数 {selector} 或 {x,y}，可选 {approach} 渐进移动路径；用于合成事件无效的站点（如微信后台）及 hover 工具条 |
| `type` | `send <id> type <tab> <params>` | 输入文本（{selector,text}），支持 input/textarea 与 contenteditable 富文本，富文本按换行分段 |
| `keyboard` | `send <id> keyboard <tab> <params>` | 向元素发送按键（{selector,key}，selector 可省略用当前聚焦元素），触发页面 keydown/keypress/keyup 处理器；可加 {ctrl,shift,alt,meta} 组合键 |
| `trigger` | `send <id> trigger <tab> <params>` | 触发元素事件（{selector,event}，可选 {value}/{options}）：blur 校验、change+value 选下拉选项、自定义事件；focus/blur 触发真实焦点转移；带 settle + waitFor |
| `upload_file` | `send <id> upload_file <tab> <params>` | 向 file input 注入本地图片（{selector,base64,filename,mime}），触发 change 事件完成上传 |
| `upload_dragdrop` | `send <id> upload_dragdrop <tab> <params>` | 向拖拽上传区（无 file input、只认 drop 的组件，如 AntD Dragger）拖入文件（{selector,data}，data 为 {base64,filename,mime} 或 {url}），派发 dragenter/dragover/drop |
| `paste_rich` | `send <id> paste_rich <tab> <params>` | 向 contenteditable 富文本编辑器粘贴带样式的 HTML（{selector,html}），等价于粘贴排好版的文档 |
| `show` | `send <id> show <tab> <params>` | 强制显示隐藏元素（{selector}），仅改 CSS 样式不执行代码；让 hover 才显示的菜单/工具条常驻可见，随后可被 click 命中 |
| `get_text` | `send <id> get_text <tab> [selector]` | 获取文本内容 |
| `get_css` | `send <id> get_css <tab> <selector>` | 获取所有匹配元素的 computed style，返回 `{selector, count, results}` |
| `get_page_info` | `send <id> get_page_info <tab> [--field ...]` | 获取页面信息 |
| `get_js_errors` | `send <id> get_js_errors <tab>` | 获取 JS 错误 |
| `clear_js_errors` | `send <id> clear_js_errors <tab>` | 清空 JS 错误 |
| `screenshot` | `send <id> screenshot <tab> <params>` | 截图当前页面（只读，不注入代码）；`{"path":"/tmp/shot.png"}` 保存到本地 |
| `scroll` | `send <id> scroll <tab> <params>` | 滚动页面 |

### click 定位方式

```json
{"selector": "#submit"}              // CSS 选择器
{"text": "登录"}                      // 按可见文字查找（优先按钮/链接）
{"x": 100, "y": 200}                 // 坐标点击
{"selector": "css:button"}           // 显式 CSS 前缀
{"selector": "xpath://btn"}          // XPath 前缀
```

选择器/text 定位**自动搜索所有 iframe**（顶层优先）；若目标在 iframe 内，可加 `frame` 参数精确指定（见「iframe 定位」）。坐标点击（`x,y`）只在顶层视口语义下命中。

### real_click

- 与 `click` 参数基本相同（selector 或 x/y），但发送**完整真实鼠标事件链**，对忽略合成事件的站点有效
- 点击后鼠标**停留在目标上**，保持 hover 状态供连续操作
- **approach 参数**：模拟"先移到触发点、再移到目标"的多级 hover 场景（如微信封面 hover 工具条：先移向封面按钮，再点击工具条里的菜单项）
  ```json
  // 先渐进经过封面按钮（触发 hover 菜单），最后点击"从图片库选择"菜单项
  {"x": 500, "y": 343, "approach": [[360, 360], [420, 330], [470, 325]]}
  ```
- **iframe 支持**：自动搜索所有 iframe（含跨域），也可用 `frame` 参数指定目标
- 适用：对合成事件免疫的站点（如微信公众平台后台 Vue 组件）、hover 才显示的工具条元素
- 注意：**坐标必须是元素真实位置**——先 `screenshot` 看真实页面，再取坐标定位。
- 副作用：attach 瞬间 Chrome 顶部会出现"正在调试此浏览器"横幅，随即消失
- 使用：`send <id> real_click <tab> '{"selector":"#submit"}'` 或 `'{"x":100,"y":200}'`，iframe 内加 `frame` 参数

### type 参数

```json
{"selector": "#username", "text": "admin"}     // input/textarea：直接设置 value
{"selector": ".ProseMirror", "text": "第一段\n\n第二段"}  // contenteditable：按换行分段插入
```

- input/textarea：设置 `value` 并触发 `input` + `change` 事件
- contenteditable（如 ProseMirror 富文本）：聚焦后按 `\n` 分段插入，保留段落结构；一次调用传入完整内容，不要多次追加（会覆盖）

### keyboard 参数

```json
{"selector": "#title", "key": "Enter"}                       // 在标题输入框按回车
{"selector": ".ProseMirror", "key": "ArrowDown"}             // 富文本里按方向键
{"key": "Escape"}                                            // 省略 selector：向当前聚焦元素按键
{"selector": "#input", "key": "Enter", "ctrl": true}         // Ctrl+Enter 组合键
```

- 先聚焦目标元素（`selector` 可省略，缺省用 `document.activeElement`），再派发 `keydown` → `keypress`（非修饰键）→ `keyup` 完整事件链
- 支持修饰键：`ctrl`/`shift`/`alt`/`meta`（布尔）
- `key` 取值同 `KeyboardEvent.key`：`Enter`、`Escape`、`Tab`、`Backspace`、`Delete`、`ArrowUp/Down/Left/Right`、`Home`/`End`、`F1`-`F12`，或单个字符（如 `"a"`、`"!"`）
- 自动补全 `keyCode`/`which` 与 `code`，兼容只监听旧式键码的页面处理器
- **合成事件**：能触发页面 JS 的 keydown/keyup 处理器（Enter 提交、Escape 关闭、方向键导航等通常由 JS 实现），但**不会触发浏览器原生默认行为**（如 input 内 Enter 换行/表单默认提交、Tab 切换焦点）；对依赖原生默认行为的场景，先 `click` 聚焦后结合页面自身 JS 处理器使用
- 自动搜索 iframe，返回 `{ key, selector, tag, modifiers }`

### trigger 参数

```json
{"selector": "#username", "event": "blur"}                          // 触发失焦（触发 blur 校验）
{"selector": "#category", "event": "change", "value": "2"}          // 选中下拉选项并触发 change
{"selector": "#agree", "event": "change", "value": true}            // 勾选 checkbox 并触发 change
{"selector": "#title", "event": "input", "value": "新标题"}          // 更新输入值并触发 input
{"selector": ".el-dialog", "event": "xhs:refresh", "options": {"detail": {"id": 1}}}  // 自定义事件
```

- 向元素派发指定事件（`blur`/`focus`/`change`/`input`/`select`/自定义事件名等），**等影响落地后返回**（settle + 可选 `waitFor`，与 `type`/`keyboard` 同语义）
- **`value`（可选）**：先设置属性再派发事件，一次调用完成"改值 + 触发"：
  - `select` → 选中 value 对应的 option；`input`/`textarea` → 设置值
  - `checkbox`/`radio` → 勾选状态（`true`/`false`）
  - **React 受控组件同样生效**
  - `value` 仅适用于 input/textarea/select，对其他元素报错
- **`options`（可选）**：透传给事件（`bubbles`/`cancelable`/`composed`/`detail` 等，默认 `{bubbles:true, cancelable:true, composed:true}`）；`detail` 传给自定义事件
- **`focus`/`blur` 触发真实焦点转移**：`:focus` 样式生效、表单校验按真实失焦处理；元素不在焦点上时也保证事件处理器触发
- 事件名以 `key`/`mouse` 开头时，`options` 支持 `key`/`code`/`clientX` 等对应属性；其他事件支持 `detail` 传自定义数据
- **合成事件**：能触发页面 JS 的事件处理器，但校验事件是否来自真实操作的站点无效（此类站点请用 `real_click`）
- 返回 `{ selector, event, tag, settledMs }`；传了 `value` 时返回 `{ value }`；传了 `waitFor` 时返回 `{ waitFor }`
- 自动搜索 iframe（含跨域），支持 `frame` 参数与 shadow DOM 穿透，`--field` 可裁剪返回

### upload_file 参数

```json
{"selector": "input[type=file]", "base64": "<base64内容>", "filename": "cover.jpg", "mime": "image/jpeg"}
```

- 将 base64 图片注入 file input 并触发 `change` 事件，页面监听到后自动上传
- 适用于无法手动操作系统文件对话框的场景（如无辅助功能权限时上传公众号封面）
- 图片建议先压缩（如 900x383 JPEG、<100KB），避免 base64 过大

### upload_dragdrop 参数

```json
{"selector": ".js_upload_area", "data": {"base64": "<base64内容>", "filename": "cover.jpg", "mime": "image/jpeg"}}
{"selector": ".js_upload_area", "data": {"url": "https://example.com/a.jpg"}}
```

- 向**没有文件输入框、只认拖拽（drop）事件**的上传区域拖入文件：派发 `dragenter` → `dragover` → `drop` 携带文件，页面 drop 处理器收到后自动上传
- 适用于 `upload_file` 打不进去的组件：AntD `Upload.Dragger`、自定义拖拽区、富文本编辑器拖图上传等
- `data` 二选一：`{base64, filename, mime}`（本地文件，推荐，与 upload_file 同源）或 `{url}`（命令内部拉取后拖入，受 CORS 限制）
- 与 `upload_file` 互补：能找到 `input[type=file]` 用 `upload_file`，找不到（拖拽区）用 `upload_dragdrop`
- 拖拽区域在 iframe/shadow DOM 内同样生效；带 settle + waitFor，返回 `{selector, tag, filename, size, mime, settledMs}`

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

**适用场景**：hover 才显示的工具条/菜单（如微信后台封面菜单「从图片库选择」）。用 `show` 直接把元素强制显示，随后普通命令即可命中，无需模拟 hover 或精确坐标。

`show` 不模拟 hover，而是把元素**直接变为常驻可见**：

- **只改 CSS 样式，不执行代码**：将所有匹配元素的 `visibility` 置为 `visible`、`opacity` 置为 `1`、`display` 若为 `none` 则置为 `block`
- 元素**常驻可见**，不会被 hover 样式重新隐藏，也不会因鼠标移动而关闭
- **默认作用于所有匹配元素**（无需 all 参数）
- 效果：强制显示后，普通 `click` 或 `real_click` 都能直接命中菜单项
- 组合用法：`show` 显示菜单项 → `click`（或 `real_click`）点击 → 后续流程 → `hide` 还原

### hide

```
send <id> hide <tabId>       // 无参数：还原全部被 show 的元素
```

- 与 `show` 成对：操作完调用 hide 还原，清掉 inline style 回到 CSS 控制，避免菜单常驻影响后续点击
- show 会记录被改元素的原始 inline 样式，hide 精确恢复
- 页面刷新后样式本身恢复原状（inline style 不持久），hide 用于不刷新页面的场景

### scroll 参数

滚动作用域由 `frame` 参数选定（语义与其他元素命令一致，见「iframe 定位」）：缺省/`auto` 滚顶层窗口，`top` 明确顶层，数字或 `{"url":"子串"}` 滚指定 iframe。

```json
{"y": 500}                        // 滚当前作用域窗口：垂直滚动
{"x": 300, "y": 500}              // 水平 + 垂直
{"y": 300, "frame": 0}            // 滚第 1 个顶层 iframe 内部
{"y": 300, "frame": {"url": "editor"}}  // 滚 url 含 "editor" 的 iframe
{"selector": ".js_list"}          // 滚动到元素：可滚动容器→容器内滚动到顶部，
                                  // 普通元素→scrollIntoView 进入可视区（含 shadow 内元素）
{"selector": ".js_list", "y": 200}    // 可滚动容器内滚动到 200px
{"selector": "#bottom", "block": "end"}  // scrollIntoView 对齐方式：start/center/end/nearest（默认 center）
```

- 无 `selector`：滚窗口（缺省顶层 / `frame` 指定的 iframe）
- 有 `selector`：目标元素经 shadow 穿透查找；元素自身可滚动（scrollHeight > clientHeight）时容器内滚动，否则 scrollIntoView
- 滚动后等 DOM 稳定（无变动 500ms，最长 3s）才返回

### screenshot

```json
{"path": "/tmp/shot.png"}    // 截图保存路径（默认 screenshot.png）
```

- 截取当前标签页（PNG），返回 base64，CLI 自动解码保存到 `path`
- 只读能力（等同 DevTools 截图），不注入代码、不修改页面
- 用于确认页面真实视觉状态（元素遮挡、浮层、滚动位置），避免仅凭 DOM 快照盲猜坐标
- 适用：操作前确认页面状态、排查点击无响应（如浮层遮罩挡住目标元素）

## 注意事项

- `text` 定位会跳过 `<script>`、`<style>`、`<noscript>` 等不可见元素，优先匹配 `<button>`、`<a>`、`<input>`；自动搜索 iframe，返回带命中 frame 的 `url`
- `--field` 对所有返回对象的命令有效（点路径投影，见「_field 过滤」章节），在浏览器端按需采集、出口统一裁剪
- `--field html`（如 `--field "currentTab.html"`）返回该 frame 的**完整 HTML 内容**（服务端与 CLI 原样转发，不会剥离），需抓页面源码时直接用它
- 同一标签页的命令串行执行，前一条完成后下一条才执行，不需要手动等待
- 点击后如果页面跳转，会自动等待新页面加载完成再返回结果
- `get_text` 对 textarea 返回空（textContent 不含 value），验证 textarea 输入用 `get_page_info --field "currentTab.html"` 抓 HTML 检查
- `get_js_errors` / `clear_js_errors` 聚合所有 frame（含 iframe）的错误，每条带 `source` 定位到具体 frame
- 扩展更新代码后需在 `chrome://extensions` 刷新扩展，且已打开页面需刷新才会重新注入新脚本
