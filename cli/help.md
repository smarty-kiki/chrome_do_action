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
| `clickDesc` | object | 点击描述（`selector`/`text`/`x,y` + `tag` + 可点性报告，见下） |
| `settledMs` | number | 等影响落地的耗时（毫秒），见「等影响落地」 |
| `currentTab` | object | 当前标签页信息（`url`、`title`、`iframes`） |
| `newTabs` | array | 新打开的标签页列表（每个包含 `tabId`、`url`、`title`、`iframes`） |
| `iframeChanges` | array | iframe 变化列表，仅在检测到变化时出现 |
| `waitFor` | object | 传入 `waitFor` 参数时的等待结果（`settled` + `waited`） |

`currentTab` 和 `newTabs` 中的 `iframes` 是该页面当前的 iframe 列表，结构同 `open` 的 `iframes`。

`clickDesc`（仅 `selector`/`text` 定位时）附带**可点性报告**——回答"这次点击用户是否真的点得到"：

| 字段 | 含义 |
|------|------|
| `visible: true` | 元素可见，目标点未被遮挡——点击正常命中 |
| `visible: false` | 元素本身隐藏或无尺寸（CSS 隐藏、尚未渲染），真实点击点不到它 |
| `coveredBy: {tag, class, text}` | 元素可见但**有别的元素盖在目标点上**（浮层/弹窗/遮罩），真实点击会点到覆盖层 |
| `offscreen: true` | 目标点不在可点击区域（元素滚动到视口外等） |

点击本身照常执行（报告只读、不拦截），但出现 `visible: false` / `coveredBy` / `offscreen` 时说明**这次点击大概率没有被页面真正接收**。先 `screenshot` 看真实状态再处理：隐藏元素确认是否加载完（或先 `show`）；被覆盖的先关掉浮层/等它消失（可配 `waitFor` 等条件出现再点）；仍不行改用 `real_click` 坐标点击。坐标定位（`x,y`）不做此报告——坐标点就是最终的命中点。

### 等影响落地（settle）

`click`/`type`/`keyboard`/`trigger`/`upload_file`/`upload_dragdrop`/`paste_rich`/`scroll`/`real_click` 返回前会**等动作的影响落地**——事件驱动（DOM 变化 + 长任务检测），不是固定 sleep：

- **无影响动作**（点击无副作用元素）：约 1s 返回（1s 活动窗口内没有任何动静，窗口耗尽即放行）
- **有影响动作**（异步渲染、debounce 重排）：活动窗口内一有动静就继续等，等 DOM 安静 250ms 后返回，`settledMs` 如实反映等待耗时
- **影响落地晚于约 1 秒的活动窗口**（服务端请求响应后才渲染、长 debounce、纯网络等待）→ 传 `waitFor` 谓词：

```json
{"selector": "#toast", "waitFor": {"selector": "#success-toast"}}
{"text": "登录", "waitFor": {"text": "发布成功"}}
```

`waitFor` 以 50ms 间隔轮询条件（元素存在且可见 / 可见文本），**条件满足的瞬间返回**（不是等满超时）：`{"settled": true, "waited": 615}`；3s 超时未满足返回 `{"settled": false}`（动作本身已成功，仅影响未确认）。

**后台标签页**：Chrome 对不可见 tab 会节流——settle 可能偏慢（无影响动作约 1.6s 返回），深度后台下影响可能等不到，此时用 `waitFor` 谓词（轮询不受节流）或把 tab 切到前台。

**60 秒天花板**：命令最慢 60 秒必须返回结果。单条命令吃满时间（页面加载极慢、长 `waitFor` + 后台 tab 节流叠加等）会撞到上限直接报超时——大任务拆成多条命令、避免对深度后台的 tab 做长时间等待。

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

通过 `--field` 指定需要的字段，精确裁剪返回结果。**所有返回对象的命令**都支持（click/type/keyboard/trigger/upload_file/upload_dragdrop/paste_rich/set_cursor/get_cursor/scroll/show/hide/get_prop/get_rect/get_viewport/get_page_info/list_elements/get_js_errors/real_click/open/refresh/close_tab——get_prop 仅在拿到普通对象值时有效），点路径逐段投影、保留嵌套形状：

- `--field a` → `{a: 完整值}`
- `--field a.b` → `{a: {b: 值}}`（脚本 `res.a.b` 恒可读）
- `--field arr.k`（arr 为数组）→ `{arr: [k1, k2, ...]}`；返回本身就是数组时同样逐项裁剪（如 `list_tabs --field url` → `[{url}, ...]`）
- **拼错的字段不会被静默吞掉**：请求了但结果里根本没有的字段名，CLI 会在 stderr 明确提示「这个字段没匹配到」，其余字段照常返回——`--field` 打错字时不必再靠"怎么是空的"来猜
- 无 `--field` 时返回全量
- `get_text` 返回纯文本字符串；`get_prop` 的值是标量（字符串/数字/布尔）时原样返回——均无字段可滤（`get_prop` 拿到普通对象值时同样支持 `--field` 裁剪）

### 常用字段路径

| 字段 | 说明 |
|------|------|
| `clickDesc.selector` / `clickDesc.text` / `clickDesc.tag` | 点击命中的元素 |
| `clickDesc.visible` / `clickDesc.coveredBy` | 可点性报告：目标是否可点、被谁遮挡（`coveredBy.tag` 可取具体字段） |
| `settledMs` | 等影响落地耗时 |
| `navigated` | 是否发生导航 |
| `currentTab` | 当前标签页完整信息（url、title、iframes） |
| `currentTab.url` | 仅 url |
| `currentTab.iframes` | 仅 iframe 列表 |
| `frame.url` | 元素命中的 frame |
| `newTabs` | 新标签页完整信息（含 iframes） |
| `newTabs.url` | 各新标签页的 url 数组 |
| `iframeChanges` | 仅返回 iframe 变化数组 |
| `count` | show/hide/get_js_errors 的计数 |
| `x` / `y` / `trusted` | real_click 的点击坐标与可信标记 |
| `hit` / `hit.text` / `hit.class` | real_click 实际点到的元素（坐标点击后断言目标是否相符） |
| `centerCss` | get_rect 的元素中心（可直接喂给 real_click {x,y}） |
| `covered` / `hitTest.text` | get_rect 的遮挡判定与中心点实际命中的元素 |
| `matchCount` / `allMatches.text` / `allMatches.priority` | get_rect 的文本歧义明细（priority 0 = click 会点的那个） |
| `viewportCss` / `scrollCss` / `dpr` | get_viewport 的视口尺寸、滚动位置、像素比 |
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

元素命令（`click`/`real_click`/`type`/`keyboard`/`trigger`/`get_text`/`get_prop`/`show`/`upload_file`/`upload_dragdrop`/`paste_rich`/`set_cursor`/`get_cursor`/`list_elements`）**默认自动搜索 iframe**：先顶层 frame，再按深度优先逐个查找所有 iframe（含跨域），首个命中的 frame 即为目标，返回中带 `frame: {frameId, url}` 标明命中位置。

如需指定 frame，加 `frame` 参数：

```json
{"selector": ".rich-editor"}                     // 缺省 = 顶层优先全 frame 自动搜索
{"selector": "#submit", "frame": "top"}          // 仅顶层 frame
{"selector": "#submit", "frame": 0}              // 第 0 个顶层 iframe（按序号）
{"selector": "#submit", "frame": {"url": "mp.weixin.qq.com"}}  // URL 含子串的首个 frame（跨域最稳）
```

- `frame` 支持 `click`/`real_click`/`type`/`keyboard`/`trigger`/`get_text`/`get_prop`/`show`/`upload_file`/`upload_dragdrop`/`paste_rich`/`set_cursor`/`get_cursor`/`list_elements`
- **跨域 iframe 同样可读可操作**：元素命令自动搜索所有 frame，跨域 iframe 同样能定位命中
- `real_click` 在 iframe 内同样可用（含跨域）
- `get_text` 不带 selector 时仍取顶层整页文本（向后兼容）；要读 iframe 文本用 `{"selector":"...","frame":{...}}`

## shadow DOM 定位

Web Components 站点（小红书创作后台等）把按钮/编辑器包在 shadow root 里，普通选择器、XPath 无法穿透。元素命令（`click`/`real_click`/`type`/`keyboard`/`trigger`/`get_text`/`get_prop`/`show`/`upload_file`/`upload_dragdrop`/`paste_rich`/`set_cursor`/`get_cursor`/`list_elements`）默认**透明穿透 open shadow root**，三种方式从显式到隐式：

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

- **封闭型 shadow 子树（closed shadow root）另走一条通道**（v0.28 起）：这类子树是页面主动封起来的，对**一切常规查询**都不可见——不只 cda 的选择器，页面里注入的任意 JS 同样看不见它（这正是不该用 `exec` 当常规解法的原因之一：它照样穿不进这类子树）。cda 换一条路子重新查一遍：
  - `list_elements {"closed": true}` —— 枚举其中的可交互元素（带 `backendNodeId`，无 `selector`）
  - `get_rect` —— 常规查询全 frame 都报「没有」时**自动**重查一遍，命中即返回真值（无需开关）
  - `click` / `real_click` / `get_rect` / `get_prop` / `get_text` —— 接受 `{"backendNodeId": N}` 直接操作其中的元素
  - `real_click` 的 `hit` 回执在这类元素上同样真实：报出的是真正会收到点击的那个按钮，而不是它外面那层壳
  - **不支持的命令会明确报错，不会静默兜底**：`type` / `keyboard` / `trigger` / `upload_*` 这类**需要选择器**的命令拿到 `backendNodeId` 会直接返回错误并列出可用命令——这类元素给不出选择器，这些动作本来就无从下手，宁可报错也不给一份看着正常、其实什么都没做的返回。要输入其中的输入框：open shadow root 用 `>>>` 选择器；封闭子树暂不支持输入
- **边界（已知且明确）**：覆盖顶层页面与**同源** iframe；跨域 iframe 里再套封闭型子树的组合当前未覆盖——真遇到时报 `not-found`，改用坐标兜底并在脚本里核对 `hit`
- `get_page_info --field html` 的 html **默认包含 shadow DOM 内容**：open shadow root 以内联 `<template shadowrootmode="open">` 形式出现在宿主元素里；无 shadow 的页面输出与之前完全一致。**封闭型子树不在 html 里**（浏览器不提供其内容）

## 文字口径：读到的就是页面上的

cda **不改写、不加工、不截断**任何读回来的文字。凡是返回里带文字的地方（`get_text` 的整页/元素文本、`get_rect.text` 与 `allMatches[].text`、`list_elements[].text`、`clickDesc` 里描述元素的文字、`real_click.hit.text`），都是页面上的**原样值**——首尾空格、换行、连续空格全部保留，不 trim、不折叠、不截断。拿去和页面比对时，拿到的就是页面上的字面量。

查询侧（`{"text":"..."}` 定位、`list_elements {"text":"..."}` 过滤）放宽一些，两种写法**任一成立即命中**：

1. 页面文字**原样包含**你给的串
2. 页面文字**折叠空白后**包含折叠后的串

于是从 `get_text`/`get_rect` 里原样复制一段文字（哪怕它带着首尾空格或换行）直接当查询串用，命中不了的概率很低；页面上多打几个空格也不影响命中。要精确定位、排除子串误命中时用 `{"exact":true}`（整段相等）。

> 两侧的差别是有意为之：**放宽的是匹配，收紧的是报告**——匹配宽松是为了好用，报告原样是为了可信。

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

### 富文本编辑器输入

富文本编辑器直接用 type 输入——文字**整段原样插入**，不按换行自动分段（文字进去后如何呈现，由编辑器自己的行为决定，cda 不做编辑器适配）。段落结构要精确可控时，一段发一次：

```bash
cda send OfficePC click current '{"selector":".rich-editor"}'
cda send OfficePC type current '{"selector":".rich-editor","text":"第一段内容。"}'
cda send OfficePC type current '{"selector":".rich-editor","mode":"append","text":"第二段内容。"}'
```

`mode` 可选（默认 `replace` 清空原内容后写入）：`append` 追加到末尾、`insert` 在光标处插入（有选中则替换选区），多次调用配合即可拼出完整内容。

### 图片上传（file input）

向页面的 file input 注入 base64 图片，触发页面上传逻辑：

```bash
# 图片先压缩并转 base64（macOS 示例）
sips -z 383 900 cover.png --out cover.jpg
B64=$(base64 -i cover.jpg | tr -d '\n')

cda send OfficePC upload_file current "{\"selector\":\"input[type=file]\",\"base64\":\"$B64\",\"filename\":\"cover.jpg\",\"mime\":\"image/jpeg\"}"
```

适用于无法操作系统文件对话框的场景（如无辅助功能权限时上传文章封面图）。

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

### 读取元素属性原值（get_prop）

`get_text` 读文本、`get_prop` 读属性——拿到的是页面上的**真实原值**，cda 不做任何加工，适合做只读校验与内容比对：

```bash
# type 后确认输入是否真的写入（读 input/textarea 的 value）
cda send OfficePC get_prop current '{"selector":"#title","prop":"value"}'

# 读取勾选/禁用等状态（checkbox 的 checked、按钮的 disabled）
cda send OfficePC get_prop current '{"selector":"#agree","prop":"checked"}'

# 读取原始内容（innerHTML/src/href/dataset/className 等任意元素属性名）
cda send OfficePC get_prop current '{"selector":".rich-text","prop":"innerHTML"}'
```

- 定位方式同 click：`{selector}` 或 `{text}`，自动搜索 iframe、穿透 shadow DOM；返回命中 frame
- `prop` 是元素**属性名**（不是 CSS 属性）；值域是元素上的真实属性，如 `value`/`checked`/`disabled`/`innerHTML`/`textContent`/`className`/`id`/`src`/`href`/`dataset`/`title`/`placeholder` 等
- **只读**：从不调用方法——`prop` 指向函数/方法时直接报错，不会替你执行
- 标量原样返回；对象值（如 `dataset`）仅在能无损转成 JSON 时返回，否则明确报错而不是静默变成 `{}`——需要这类内容时改读字符串属性（`innerHTML`/`className`）或用 `get_text`
- 属性不存在时同样明确报错（附常见属性示例），不会静默返回空值

### 取几何真值并按坐标点击（含命中自检）

```bash
# 1. 量目标：拿到权威 centerCss（与 real_click 同一坐标口径）
cda send OfficePC get_rect current '{"text":"发布","exact":true}' --field "centerCss,covered,hitTest.text"

# 2. 有歧义先看清：谁会被点到（priority 0），其余是被子串匹配误伤的兄弟
cda send OfficePC get_rect current '{"text":"发布","all":true}' --field "matchCount,allMatches.text,allMatches.priority"

# 3. 按坐标点，并回读实际命中——不符就中止
cda send OfficePC real_click current '{"x":214,"y":1008}' --field "hit,navigated"
```

目标在封闭型 shadow 子树里时改走 backendNodeId 闭环，全程不碰坐标、不看截图：

```bash
cda send OfficePC list_elements current '{"closed":true}' --field "elements.backendNodeId,elements.text,elements.inClosedShadowRoot"
cda send OfficePC get_rect current '{"backendNodeId":4211}' --field "centerCss,covered"
cda send OfficePC click current '{"backendNodeId":4211}' --field "clickDesc,settledMs"
```

### 滚动加载长页面

滚动到底部等待内容加载（如懒加载的列表）：

```bash
cda send OfficePC scroll current '{"y": 99999}'
```

返回时滚动已经到位、DOM 也已稳定，适合配合 `get_text` 提取新加载的内容。

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

所有页面命令都需要指定标签页（`current` 或数字 tabId），浏览器命令不需要。JSON params 只用于页面命令——浏览器命令里 `open` 的参数是**裸 URL 字符串**：`send <id> open https://example.com` ✅，`send <id> open '{"url":"https://example.com"}'` ❌（CLI 会拒绝并提示）。

### 浏览器命令

| 命令 | 用法 | 说明 |
|------|------|------|
| `open <url>` | `send <id> open <url>` | 打开新标签页，等待加载完成。参数是 URL 字符串，不是 JSON params |
| `list_tabs` | `send <id> list_tabs` | 列出所有标签页 |
| `close_tab <id>` | `send <id> close_tab current` | 关闭标签页 |
| `refresh <id>` | `send <id> refresh current` | 刷新标签页，等待加载完成 |

### 页面命令

| 命令 | 用法 | 说明 |
|------|------|------|
| `click` | `send <id> click <tab> <params>` | 点击元素（合成事件） |
| `real_click` | `send <id> real_click <tab> <params>` | 真实点击（对忽略合成事件的站点有效），参数 {selector}/{x,y}/{backendNodeId}，可选 {approach} 渐进移动路径；用于合成事件无效的站点及 hover 工具条。**返回命中回执 `hit`**（点到谁：tag/class/text/backendNodeId），坐标给错时能断言并中止 |
| `type` | `send <id> type <tab> <params>` | 输入文本（{selector,text[,mode]}）：文字原样插入、不拆分加工；input/textarea 直接写入，富文本编辑区整段原样插入（怎么呈现由编辑器决定，cda 不做适配）；mode：replace 清空后写入（默认）/append 追加/insert 光标处插入 |
| `keyboard` | `send <id> keyboard <tab> <params>` | 向元素发送按键（{selector,key}，selector 可省略用当前聚焦元素），触发页面 keydown/keypress/keyup 处理器；可加 {ctrl,shift,alt,meta} 组合键 |
| `trigger` | `send <id> trigger <tab> <params>` | 触发元素事件（{selector,event}，可选 {value}/{options}）：blur 校验、change+value 选下拉选项、自定义事件；focus/blur 触发真实焦点转移；带 settle + waitFor |
| `upload_file` | `send <id> upload_file <tab> <params>` | 向 file input 注入本地图片（{selector,base64,filename,mime}），触发 change 事件完成上传 |
| `upload_dragdrop` | `send <id> upload_dragdrop <tab> <params>` | 向拖拽上传区（无 file input、只认 drop）拖入文件：默认派发 dragenter/dragover/drop（data 为 {base64,filename,mime} 或 {url}）；`{trusted:true}` + `data.path`（本机绝对路径）走浏览器级真实拖放（isTrusted=true），过微信媒体库这类校验受信任拖放的组件 |
| `paste_rich` | `send <id> paste_rich <tab> <params>` | 向富文本编辑器粘贴带样式的 HTML（{selector,html[,mode]}，mode 同 type：replace 先清空再粘贴/append 追加/insert 光标处插入） |
| `set_cursor` | `send <id> set_cursor <tab> <params>` | 把光标**精确定位到编辑区正文某个文字片段前后**（{selector,text[,occurrence][,position]}）：after 匹配后（默认）/before 匹配前/start 所在行行首/end 所在行行尾，occurrence 取第 N 次出现（默认 1）；落点后读回实际光标 {row,col,text} |
| `get_cursor` | `send <id> get_cursor <tab> <params>` | 读编辑器当前光标位置（{selector}），返回 {inEditor,row,col,text}——row 0 基行号、col 行内字符偏移、text 所在行全文；光标不在编辑区时 inEditor:false + null |
| `show` | `send <id> show <tab> <params>` | 强制显示隐藏元素（{selector}），仅改 CSS 样式不执行代码；让 hover 才显示的菜单/工具条常驻可见，随后可被 click 命中 |
| `get_text` | `send <id> get_text <tab> [selector]` | 获取文本内容 |
| `get_prop` | `send <id> get_prop <tab> <params>` | 读取元素属性的真实原值（`{selector\|text, prop}`），只读、从不调用方法；字符串/数字/布尔等标量原样返回；值无法无损转 JSON 时明确报错（不静默变空） |
| `get_rect` | `send <id> get_rect <tab> <params>` | **元素几何真值**：`{selector\|text\|xpath}/{selectors:[...]}/{backendNodeId}` → rectCss + centerCss + 可见性 + 遮挡（covered/hitTest）+ 歧义（matchCount/allMatches）+ `waitStableMs` 等稳定。**坐标口径与 real_click {x,y} 完全一致**：取到 centerCss 直接喂给 real_click 即命中同一元素 |
| `get_viewport` | `send <id> get_viewport <tab>` | **视口真值**：`{viewportCss:{w,h}, dpr, scrollCss:{x,y}, screenCss:{w,h}}`。截图换算的权威来源；dpr 与 screenshot 的 `imagePx.w / viewportCss.w` 一致 |
| `get_page_info` | `send <id> get_page_info <tab> [--field ...]` | 获取页面信息 |
| `list_elements` | `send <id> list_elements <tab> <params>` | 列出可交互元素（带生成好的 selector、可见性、坐标、关键属性），支持 filter/text/max/visible 过滤；`{closed:true}` 连**封闭型 shadow 子树**内的元素一起列（这类条目只有 backendNodeId，没有 selector）；找不到元素时先查它 |
| `get_js_errors` | `send <id> get_js_errors <tab>` | 获取 JS 错误 |
| `clear_js_errors` | `send <id> clear_js_errors <tab>` | 清空 JS 错误 |
| `screenshot` | `send <id> screenshot <tab> <params>` | 截图当前页面（只读，不注入代码）；`{"path":"/tmp/shot.png"}` 保存到本地。CLI 打印 JSON：`{path, bytes, imagePx, viewportCss, dpr, scale, chromeInsetCss, scrollCss, mapping}`——换算元数据与图一起回，坐标不再靠猜 |
| `scroll` | `send <id> scroll <tab> <params>` | 滚动页面 |
| `exec` | `send <id> exec <tab> <params>` | ⚠ **仅排查问题**：在页面里执行任意 JS 并返回结果（{code}）。高风险，默认关闭——必须先到插件配置页勾选「允许 exec 命令（仅排查问题）」，见下方「排查问题：exec」 |

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

- 与 `click` 参数基本相同（selector / x,y / backendNodeId），但发送**完整真实鼠标事件链**，对忽略合成事件的站点有效
- 点击后鼠标**停留在目标上**，保持 hover 状态供连续操作
- **approach 参数**：模拟"先移到触发点、再移到目标"的多级 hover 场景（如悬停才展开的工具条：先移向触发点，再点击其中的菜单项）
  ```json
  // 先渐进经过触发点（打开 hover 菜单），最后点击其中的菜单项
  {"x": 500, "y": 343, "approach": [[360, 360], [420, 330], [470, 325]]}
  ```
- **iframe 支持**：自动搜索所有 iframe（含跨域），也可用 `frame` 参数指定目标
- 适用：对合成事件免疫的站点（合成 click 提示成功却不触发）、hover 才显示的工具条元素
- 副作用：执行瞬间 Chrome 顶部会闪过一条提示条（正常现象），随即消失
- 使用：`send <id> real_click <tab> '{"selector":"#submit"}'` 或 `'{"x":100,"y":200}'`，iframe 内加 `frame` 参数
- **`{backendNodeId: N}` 定位**：点击封闭型 shadow 子树内、任何选择器都寻址不到的元素（N 从 `list_elements {"closed":true}` 或 `get_rect` 的返回里拿）

**命中回执 `hit`（坐标点击的"假成功"终结者）**

坐标是猜的，返回成功不代表点对了元素——以前这是静默的。现在 `real_click` 回报**它实际点到了谁**：

```json
{
  "x": 214, "y": 1008, "trusted": true, "navigated": false, "settledMs": 612,
  "hit": { "tag": "button", "class": "d-button", "text": "暂存离开",
           "backendNodeId": 4211, "inClosedShadowRoot": true }
}
```

- `hit` 在**鼠标渐进到位、按下之前**采样：既保证"我即将点到谁"是真的，又不受点击后果（页面跳转/元素消失）干扰
- 命中判定在封闭型 shadow 子树里**同样真实**：拿到的是真正会收到点击的那个按钮，而不是它外面那层壳
- 于是脚本可以这样自保：点到「暂存离开」= 坐标算错 → **立即中止**，不再糊里糊涂中断发布流程
- **两个显式的拒收**（坐标给错就当场报错，不会"看起来成功"）：只给了一半坐标（`{"y":300}`）会提示必须 `{x, y}` 成对传；坐标落在页面可视区之外（如 `y:-400`、超过视口高）会明确说"那里什么都收不到，所以没有派发"，并提示先滚进可视区（`get_rect {"scroll":true}`）或改用 selector/text/backendNodeId 让命令自己滚
- `hitUnavailable` 字段说明 `hit` 缺失的原因（如命中点不在任何可描述节点上）
- `warning?` 只在链路里**非致命但没按预期完成**的步骤出现（窗口不可聚焦导致激活挂起被放弃、鼠标轨迹没走完）——点击照常派发，但"点了却没反应"时先看这里，它把原因写明了（`upload_dragdrop trusted` 同样有这个字段）
- `navigated` 由点击前后的真实 URL 对比得出（click/real_click 都报），`settledMs` 是等页面稳定实际花掉的毫秒数

给坐标前先用 `get_rect` 拿 `centerCss`，这是唯一不会错位的取坐标方式：

```bash
cda send OfficePC get_rect current '{"text":"暂存离开"}' --field "centerCss"   # {"centerCss":{"x":214,"y":1008}}
cda send OfficePC real_click current '{"x":214,"y":1008}' --field "hit.text"    # "暂存离开" → 确认
```

### get_rect 参数

**元素几何真值，与 `real_click {x,y}` 同一坐标口径。** 这条命令存在的唯一理由：让「量一个坐标」和「点一个坐标」说的是同一件事——`centerCss` 原样喂给 `real_click`，点中的就是这里量到的那个元素。

```json
{"selector": "#submit"}                 // CSS
{"text": "暂存离开"}                     // 按可见文字查找（子串匹配）
{"text": "发布", "exact": true}          // 精确匹配（整段文字相等），排除子串误命中
{"selector": "xpath://button"}           // XPath 前缀
{"all": true}                            // 强制带出全部候选明细（有歧义时默认也会带）
{"waitStableMs": 300}                    // 等矩形连续 300ms 不变再返回
{"selectors": [".a", ".b", ".c"]}        // 批量：一次往返拿多个矩形
{"scroll": true}                         // 先把元素滚进可视区再量（量到的坐标保证可点）
{"backendNodeId": 4211}                  // 封闭型 shadow 子树内的元素（来自 list_elements {"closed":true}）
```

返回（均为增补字段，`x/y/width/height` 语义与取值不变）：

```json
{
  "selector": "button.d-button", "x": 214, "y": 1008, "width": 96, "height": 32,
  "rectCss": {"x":166,"y":992,"w":96,"h":32}, "centerCss": {"x":214,"y":1008},
  "tag": "button", "class": "d-button", "text": "暂存离开",
  "visible": true, "covered": false,
  "hitTest": {"tag":"button","class":"d-button","text":"暂存离开","backendNodeId":4211,"inClosedShadowRoot":true},
  "matchCount": 1,
  "waitStable": {"waited": 312, "stable": true},
  "backendNodeId": 4211, "inClosedShadowRoot": true, "source": "cdp-pierced"
}
```

- **坐标口径 = 顶层视口 CSS 像素**：`centerCss` 即顶层 `getBoundingClientRect()` 的中心；iframe 内元素的坐标**已加好 frame 偏移**，不需要手工换算（见「坐标口径」）
- **`covered` / `hitTest` 回答「会不会点歪」**：`hitTest` 是中心点实际命中的元素，语义与 `click` 返回的 `clickDesc.coveredBy` 一致；在封闭型 shadow 子树里同样真实。`covered:true` 表示中心被别的元素压住，照这个坐标点会点到压住它的那个
- **`matchCount` / `allMatches` 回答「是不是点错了兄弟」**：`{"text":"发布"}` 是**子串**匹配，页面上「发布笔记」「发布」可能同时命中。`matchCount > 1` 时返回明细，每项带 `rectCss`/`visible`/`priority`——**`priority: 0` 就是 `click {"text":...}` 会点的那个**（只在可见候选间排序），其余是此前被静默忽略的兄弟。只报告、不改变既有选择行为；要精确指定用 `{"exact":true}`
- **`{"all":true}` 会把封闭子树里的同名命中也算进来**：常规查询看不见这类子树，只报它自己那份会把歧义报成 `matchCount:1`（实测：「发布笔记」+ 页脚闭包里的「发布」被报成只剩前者）。显式要全貌时会多查一遍，把其中的命中**追加**进 `allMatches`（带 `inClosedShadowRoot:true` + `backendNodeId`，`priority` 顺延），并附 `matchCountNote` 说明两半各来自哪一步——`priority:0` 的语义不变，仍是 `click {"text":...}` 会选中的那个
- **`waitStableMs`**：矩形连续 N 毫秒不变才算定稿（懒加载、动画、字体回流都会让矩形漂移），返回 `waitStable: {waited, stable}`；`stable:false` 表示等到超时仍在动
- **批量 `{selectors:[...]}`**：一次返回 `{count, items:[{selector, 各矩形字段...}]}`；每项**自带 `code`**，单条失败不中断整批（`found:false` + `code`），跨 frame / 跨闭包的项各自解析
- **封闭型 shadow 子树自动兜底**：常规查询全 frame 都报「没有」时会自动再查一遍这类子树，命中即返回带 `backendNodeId` + `inClosedShadowRoot:true` 的真值（无需开关）。详见「shadow DOM 定位」
- 走封闭子树通道的结果另带 `viewportCss`（量这份几何时的视口尺寸）和 `source`（来源标记）：用途只有一个——**提醒这份坐标与别的命令报的可能不是同一个视口口径**（见「坐标口径」）。两者口径一致时返回里会带 `viewportNote` 说明，那种情况下 `real_click {x,y}` 和 `click {x,y}` 都配得上
- **错误码可区分**（不再统一 `no match`）：
  - `not-found` —— **真的不存在**
  - `unreachable-subtree` —— **存在但不可寻址**：找到了，却没有可用几何（不可见 / 没有布局盒 / 给不出选择器 / 节点已失效）
  - `cdp-unavailable` —— 调试通道被占用（最常见的原因：DevTools 正开着），关掉 DevTools 重试
  - 被遮挡**不是**错误，是返回里的 `covered` / `hitTest`

### get_viewport

```
send <id> get_viewport <tab>        # 只读
```

**视口真值**——截图换算与坐标校验的权威来源：

```json
{
  "viewportCss": {"w": 1440, "h": 813},
  "scrollCss": {"x": 0, "y": 500},
  "dpr": 2, "devicePixelRatio": 2,
  "screenCss": {"w": 1440, "h": 900},
  "isTop": true, "url": "https://creator.xiaohongshu.com/..."
}
```

- 与 `screenshot` 元数据**必须自洽**：`imagePx.w / dpr === viewportCss.w`
- 读的是**被路由到的那个 frame**（缺省顶层）；`frame` 指到 iframe 时 `isTop: false` 如实上报，避免拿子 frame 的数字去换算顶层截图
- 不缓存：改窗口尺寸 / 缩放后重新调用即得新值
- 另带 `visualViewportCss`（缩放、软键盘下的可视视口）
- **这条命令报的是「页面上没有提示条时」的视口**。`real_click`/`screenshot`/传 `backendNodeId` 的命令因为执行期间会浮出提示条，看到的会矮一条——两者都要用，别混用（见「坐标口径」）

### 坐标口径（一句话承诺）

`real_click {x,y}` = `get_rect.centerCss` = `list_elements` 的 `x/y` = `screenshot` 换算结果 —— **全部是顶层视口 CSS 像素**（顶层 `getBoundingClientRect()` 的单位）。

从别处来的偏移量必须先换算再喂进去：截图里的原始像素要 `/ dpr`，页面绝对坐标要先减掉 `scrollCss`。按这个口径取坐标，永远不需要手工加 iframe 偏移。

#### ⚠️ 两个视口空间：别跨命令搬运坐标

部分命令执行期间，Chrome 会在页面顶部浮出一条提示条，**可视区域随之变矮一条**（实测：1440×749 的页面，浮出后稳定在 1440×693，差 56px；提示条还有一段展开动画，动画期间数值还在变）。于是同一页面存在两个视口：

| 空间 | 谁在这个空间里 |
| --- | --- |
| **有提示条**（矮一条） | `real_click`、传 `backendNodeId` 的命令、`screenshot` 拍到的图、`get_rect` 的兜底通道、`list_elements {closed:true}` 的闭包条目 |
| **无提示条**（完整高度） | `get_viewport`、`list_elements` 的普通条目、`click {"x","y"}`、`get_rect` 的常规通道 |

- **顶部锚定的静态内容两个空间坐标相同**（不重排）；**底部锚定（页脚 fixed）/ 垂直居中 / `vh` 计量的元素会差一条的高度**。页脚按钮正是这一类——量到的 y 相差 56px 属于正常，不是谁算错了
- **使用者只需守一条规则：坐标别跨命令搬运。** 别拿 `get_viewport` 去校验或补偿 `screenshot`，反之亦然，也别用其中一个去补偿自己手算的坐标。要动手就二选一：① 用 `get_rect` 取 `centerCss`，紧接着 `real_click` 用同一份坐标（这两者同一口径）；② 更稳的是直接给 `selector`/`text`/`backendNodeId`，让命令自己量自己点
- **同一条命令内部的「量」与「点」永远在同一空间**，不需要使用者补偿：命令会等提示条真的出现再测量/派发，`real_click {selector|text}` 还会把页面里量到的坐标在那一空间重新量一次——「底部锚定的目标点歪」这个坑已堵住。真有某次会话提示条始终没浮出来，就照实测量并在结果里带 `viewportNote` 说明

### type 参数

```json
{"selector": "#username", "text": "admin"}     // input/textarea：直接写入 value
{"selector": ".rich-editor", "text": "第一段"}  // 富文本编辑区：整段原样插入（分段由编辑器自己决定）
```

- input/textarea：`replace` 直接写入 value；`append` 在末尾追加；`insert` 在光标处插入（有选中则替换选区）——写入后触发 `input` + `change` 事件
- 富文本编辑区：聚焦后整段**原样插入，零加工**——不 trim、不按 `\n` 拆分、不改写文本；文字进去后怎么呈现由编辑器自己决定，cda 不做编辑器适配。段落结构要精确可控就一段发一次：先 `replace`（默认，清空原内容后写入），之后用 `append` 逐段追加
- `mode`：`replace`（默认，清空原内容后写入）/ `append`（追加到末尾）/ `insert`（光标处插入，有选中替换选区）
- 返回 `{selector, mode, tag, settledMs}`，带 settle + `waitFor`（语义见「等影响落地」）

### keyboard 参数

```json
{"selector": "#title", "key": "Enter"}                       // 在标题输入框按回车
{"selector": ".rich-editor", "key": "ArrowDown"}             // 富文本里按方向键
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
- **注入前预检 accept**：文件类型与 input 的 accept 不匹配时直接报错（如 PNG 注入 `accept="video/*"` 的 input），不会"注入成功但页面静默忽略"
- 适用于无法手动操作系统文件对话框的场景（如无辅助功能权限时上传文章封面图）
- 图片建议先压缩（如 900x383 JPEG、<100KB），避免 base64 过大

### upload_dragdrop 参数

```json
{"selector": ".upload-area", "data": {"base64": "<base64内容>", "filename": "cover.jpg", "mime": "image/jpeg"}}
{"selector": ".upload-area", "data": {"url": "https://example.com/a.jpg"}}
{"selector": ".upload-area", "trusted": true, "data": {"path": "/Users/me/pic.jpg"}}
```

- 默认（合成）路径：向**没有文件输入框、只认拖拽（drop）事件**的上传区域派发 `dragenter` → `dragover` → `drop` → `dragleave` 携带文件，页面 drop 处理器收到后自动上传（合成事件 `isTrusted: false`）
- 适用于 `upload_file` 打不进去的组件：自定义拖拽区、富文本编辑器拖图上传等
- `data`：`{base64, filename, mime}`（本地文件，推荐，与 upload_file 同源）或 `{url}`（命令内部拉取后拖入，受 CORS 限制）走默认合成路径；`{path}`（**本机绝对路径**）仅配合 `trusted: true`
- **`trusted: true`**：把磁盘文件以**浏览器级真实拖放**放进目标（`isTrusted: true`、`dataTransfer.files` 为真实 File）——页面校验「真实受信任拖放」时（如微信媒体库）合成事件会被拒，用此模式；前提：文件在运行 Chrome 的本机上（由 Chrome 读盘）；返回 `{selector, filename, x, y, trusted, settledMs}`（拿不到 size/mime）
- 与 `upload_file` 互补：能找到 `input[type=file]` 用 `upload_file`，找不到（拖拽区）用 `upload_dragdrop`
- 拖拽区域在 iframe/shadow DOM 内同样生效；合成路径带 settle + waitFor，返回 `{selector, tag, filename, size, mime, settledMs}`

### paste_rich 参数

```json
{"selector": ".rich-editor", "html": "<section style=\"text-align:center\"><span style=\"font-weight:bold;font-size:17px\">小标题</span></section>"}
```

- 向富文本编辑器粘贴带内联样式的 HTML（字号/颜色/加粗/间距写在 HTML 里一并落地，怎么呈现由编辑器决定）
- `mode`：`replace`（默认，先清空目标编辑器现有内容再插入，等价于"全选删除后粘贴"）/ `append`（追加到末尾）/ `insert`（光标处插入，有选中替换选区）
- 粘贴行为：HTML 交给编辑区的粘贴处理，**块级结构（段落/标题/列表/表格）由富文本编辑器自己解析分段**，字号/颜色/加粗等样式随 HTML 一并落地；普通可编辑区域无此解析，内容以纯文本或 HTML 原样进入。具体呈现因编辑区而异，cda 不做任何编辑器适配——怎么适应是调用方 agent 的事
- 返回值 `pipeline` 表明本次内容以哪种方式落地：`editor_paste` = 编辑器完整接管、按块解析（富文本编辑器上的预期值）；`default_paste` = 无编辑器接管，内容以纯文本行进入编辑区；`insertHTML_fallback` = 无编辑器接管，HTML 原样进入编辑区（富文本编辑器出现此值说明它没处理这次粘贴，块级结构可能不分段）
- 与 `type`（纯文本）互补：type 写字，paste_rich 粘贴排版
- 不修改页面源代码，仅向编辑器内容区插入富文本

### set_cursor 参数

```json
{"selector": ".rich-editor", "text": "#发布", "position": "after"}    // 光标落到该文字后（触发联想浮层/继续输入）
{"selector": ".rich-editor", "text": "#发布", "position": "before"}   // 光标落到该文字前
{"selector": ".rich-editor", "text": "关键词", "position": "start"}   // 光标落到匹配所在行的行首
{"selector": ".rich-editor", "text": "关键词", "position": "end"}     // 光标落到匹配所在行的行尾
{"selector": ".rich-editor", "text": "#发布", "occurrence": 2}        // 正文出现多处同名文字时取第 2 次（默认 1）
```

- **用途**：把光标**精确定位到编辑区正文某个文字片段前后**。富文本编辑器里光标只停在真实落点，type/paste_rich 只能作用在末尾或选区——要"移到正文中某段文字后触发联想浮层、把后续内容插到指定位置"时用它
- `text` 按编辑区正文文字顺序匹配（文字拆在多个 span/标签里同样命中；跳过脚本/隐藏内容）；`position` 四选：`after`（默认，匹配文字之后）/ `before`（匹配文字之前）/ `start`（匹配所在行行首）/ `end`（匹配所在行行尾）
- `occurrence`：第 N 次出现，默认 1；匹配不到时**报错并附全文出现次数**，据此调整 occurrence
- **落点以读回为准**：命令落点后等编辑器归整落地，再读回实际光标——返回 `{row, col, text}`：`row` 为 0 基行号、`col` 为行内字符偏移（JS 字符串下标，`text.slice(0, col)` 即光标前的文字）、`text` 为光标所在行全文。编辑器可能把光标归整到相邻位置，读回值如实反映最终状态，用它校验目标是否达成
- 只移动光标：不产生输入事件、不修改任何文字；光标移动引起的联动（联想浮层等）是编辑器自己的行为，等它落地的时间计入 `settledMs`
- 目标元素须为 contenteditable 编辑区；带 settle + `waitFor`（语义见「等影响落地」）

### get_cursor 参数

```json
{"selector": ".rich-editor"}    // 读当前光标所在位置
```

- 读编辑器当前光标：返回 `{selector, inEditor, row, col, text}`——`row` 0 基行号、`col` 行内字符偏移（JS 字符串下标）、`text` 光标所在行全文
- 光标不在该编辑区内（焦点在页面其他位置等）**不是错误**：`inEditor: false` + `row`/`col`/`text` 为 null
- 典型用法：`set_cursor` 后对账实际落点；手动操作过编辑器后读当前光标位置继续操作
- 目标元素须为 contenteditable 编辑区；自动搜索 iframe（含跨域），支持 `frame` 参数与 shadow DOM 穿透，`--field` 可裁剪返回

### list_elements 参数

`list_elements` 是「页面元素地图」：一条命令拿到全页可交互元素清单（带生成好的 selector、可见性、坐标、关键属性），agent 从「猜 selector」变成「先查再操作」。**找不到元素时先跑它**。

```json
{}                                              // 默认：全部元素
{"filter": "upload"}                            // 只返回上传相关：input[type=file] + 拖拽区（文本含 上传/拖拽/drop 等）
{"filter": "button,link"}                       // 逗号分隔类型白名单：button/link/input/select/textarea/label/editable/upload
{"text": "发布"}                                // 只返回文本含子串的元素
{"visible": true}                               // true 只要可见元素，false 只要隐藏元素（如被 CSS 隐藏的 file input）
{"max": 10}                                     // 输出上限（1-200，默认 50），超出返回 truncated: true
{"frame": "top"}                                // 只扫顶层；缺省=聚合所有 frame（跨域 iframe 同样列出，元素带 frame url）
{"closed": true}                                // 额外列出 closed shadow root 内的可交互元素（默认关闭）
```

返回：

```json
{
  "count": 12,
  "truncated": false,
  "elements": [
    {
      "tag": "input", "type": "file", "accept": "image/png,image/jpeg,...", "multiple": true,
      "name": "", "placeholder": "", "ariaLabel": "", "text": "",
      "visible": false, "x": 0, "y": 0, "w": 1, "h": 1,
      "selector": "input[accept*=\"image\"]", "frame": "https://.../upload"
    },
    { "tag": "button", "text": "上传图文", "visible": true, "x": 480, "y": 320, "w": 96, "h": 32,
      "selector": "button.container-drag-btn-k6XmB4" }
  ]
}
```

- **元素范围**：可点击/可输入的常见元素（button/a/select/textarea/input/label、富文本编辑区、tabindex、常见交互 role），**穿透 open shadow DOM**；被 CSS 隐藏的（如 display:none 的 tab 页里的 file input）也会列出（`visible: false`）
- **`{closed:true}` 列出封闭型 shadow 子树内的元素**（**默认关闭，不开时输出与之前逐字一致**）：这类元素对**一切常规查询都是「不存在」**的——选择器、open-shadow 穿透、整页枚举全都看不到它们，但这不等于元素不在。开启后会专门查一遍，条目**排在列表最前**（防止 `max` 把整块能力静默截掉），带 `backendNodeId` + `inClosedShadowRoot: true` 但**没有 `selector`**（这类元素给不出稳定选择器，是页面的封装方式使然，不是 cda 偷懒）
- **怎么用这类条目**：把 `backendNodeId` 直接喂给 `click` / `real_click` / `get_rect` / `get_prop` / `get_text`，形成「枚举 → 核对 → 量矩形 → 下手」的闭环，全程不碰坐标也不碰截图
- **边界**：能用 `backendNodeId` 的就是上面这五个命令。**`type` / `keyboard` / `trigger` / `upload_*` 拿到 `backendNodeId` 会明确报错**（不是静默忽略参数，也不是退化成量矩形）——它们要靠选择器才能定位到输入对象，闭包节点没有选择器，所以闭包内的输入框/上传控件暂不支持；这类元素若在 **open** shadow root 里，用 `>>>` 选择器即可
- 闭包条目的 `x/y` 是在**有提示条的视口**（见「坐标口径」）里量的，与同一份返回里普通条目的 `x/y` 不是同一空间——底部锚定的元素会差一条的高度。**要动手就用 `backendNodeId`**（命令会在动手时重新量），别把这类坐标跨界喂给 `click {"x","y"}`
- 返回 `closedCount`（闭包内元素条数）；闭包那一趟没跑成时 `closedError` 说明原因——**不会静默报 0**；若截断丢掉了闭包条目，`warning` 会写明丢了几条
- **`selector` 由 cda 自动生成**，**可直接喂给 click/type/upload_file 等任何命令**；shadow 内的元素会带 `>>>` 连接符
- **input 附加属性**：`type`/`accept`/`multiple`/`name`/`placeholder`；通用附加 `role`/`ariaLabel`/`title`/`text`（截断 80 字符）
- **缺省聚合所有 frame**：非顶层 frame 的元素带 `frame` 字段（来源 url）；指定 `frame` 参数则只扫目标 frame（语义同其他元素命令）
- 典型用法：`list_elements` → 从结果挑目标 → 用返回的 `selector` 直接操作；`filter=upload` 找上传控件、`visible=false` 找隐藏 file input、`text` 找带文字的按钮
- 完整示例：`cda --server ws://127.0.0.1:12345 send OfficePC list_elements current '{"filter":"upload"}'`——想找上传控件先跑这一条，从返回里挑目标
- 多 file input 页面（如抖音上传页的「视频/图文」两个 tab 各一个 input）用 `--field "elements.accept,elements.selector"` 对比 accept 再选目标，避免注入错 input

### show

```
send <id> show <tabId> '.toolbar-menu'        // selector 直接位置参数
```

**适用场景**：hover 才显示的工具条/菜单（悬停才展开的后台菜单等）。用 `show` 直接把元素强制显示，随后普通命令即可命中，无需模拟 hover 或精确坐标。

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
{"selector": ".scroll-list"}      // 滚动到元素：可滚动容器→容器内滚动到顶部，
                                  // 普通元素→scrollIntoView 进入可视区（含 shadow 内元素）
{"selector": ".scroll-list", "y": 200}    // 可滚动容器内滚动到 200px
{"selector": "#bottom", "block": "end"}  // scrollIntoView 对齐方式：start/center/end/nearest（默认 center）
```

- 无 `selector`：滚窗口（缺省顶层 / `frame` 指定的 iframe）
- 有 `selector`：目标元素经 shadow 穿透查找；元素自身可滚动（scrollHeight > clientHeight）时容器内滚动，否则 scrollIntoView
- **返回时滚动已经落地**（返回的 `scrollX`/`scrollY` 就是终值，不是半路的位置），随后等 DOM 稳定（事件驱动：DOM 安静 250ms 即放行，无影响约 0.6s，最长 3s 超时兜底，语义同「等影响落地」）

### screenshot

```json
{"path": "/tmp/shot.png"}    // 截图保存路径（默认 screenshot.png）
```

CLI 打印的不再只有路径，而是**图 + 换算元数据**（base64 写盘、不进 stdout）：

```json
{
  "path": "/tmp/shot.png", "bytes": 284113,
  "imagePx": {"w": 2880, "h": 1626},
  "viewportCss": {"w": 1440, "h": 813},
  "dpr": 2, "scale": 2,
  "chromeInsetCss": {"top": 0, "left": 0},
  "scrollCss": {"x": 0, "y": 500},
  "mapping": "imagePx = (cssViewportPx + chromeInsetCss) * dpr; css = imagePx / dpr"
}
```

- **`imagePx.w / dpr === viewportCss.w` 恒成立**——截图与视口严格 1:1（不含浏览器 UI、不含标签栏）。因此 `chromeInsetCss` 由构造即为 `{top:0,left:0}`：它不是「不确定的偏移」，而是每次运行都断言的不变量。断言若不成立，返回里带 `warning` 如实说明，**绝不给出错误的 mapping**
- `viewportCss` **是从图本身反推的**（`imagePx / dpr`）：图是这次拍到的既成事实，用它自己的尺寸描述它，`imagePx.w / dpr === viewportCss.w` 便由构造成立、不受拍照瞬间页面在动的影响。另附 `viewportSource` 说明这是**附加态视口**（见「坐标口径」）——它可能比 `get_viewport` 报的矮一条信息条的高度
- 拍照前会**等提示条展开动画结束**再按快门；拍完再量一次视口做交叉校验，两者对不上（差 > 1 CSS px）就在 `warning` 里如实说明是哪一轴差了、为什么，而不是把不一致咽下去
- **图像像素 → CSS 坐标**：`css = imagePx / dpr`，得到的正是 `real_click {x,y}` 吃的那个坐标（见「坐标口径」）
- `--field` 裁剪不影响写盘：base64 是 CLI 写盘用的原料，会被强制保留并在打印前剔掉。若扩展返回里没有图像数据，命令**报错退出**（绝不"成功返回 + 磁盘上没图"）
- 截取当前标签页（PNG），只读能力（等同 DevTools 截图），不注入代码、不修改页面
- 用于确认页面真实视觉状态（元素遮挡、浮层、滚动位置）；但**要坐标请优先用 `get_rect`**——从像素反推坐标是下策，`get_rect` 直接给你权威值
- 适用：操作前确认页面状态、排查点击无响应（如浮层遮罩挡住目标元素）

### 排查问题：exec（高风险，仅排查问题使用）

> ⚠ **exec 只在排查问题时临时使用**。它把一段**任意 JavaScript 注入页面执行**——可以读取、修改页面乃至浏览器内的一切数据。日常流程不要用 exec：需要做什么动作请用上面的具体命令（click/type/get_prop 等）。排查完毕后请关闭开关。

用法（与页面命令同形，tab 必填）：

```bash
cda send OfficePC exec current '{"code":"document.title"}'
cda send OfficePC exec current '{"code":"window.__INITIAL_STATE__.article"}'
cda send OfficePC exec current '{"code":"document.querySelector(\"#price\").textContent.trim()"}'
```

**先决条件——插件配置开关**：exec 默认关闭。第一次使用前必须到插件配置页（点击扩展图标 →「打开配置页」）勾选**「允许 exec 命令（仅排查问题）」**并保存。未启用时命令被浏览器端直接拒绝，返回明确报错（含启用路径），代码不会执行。开关每次执行都实时生效：勾选后立即可用，取消勾选后立即回到拒绝态——**无需重启浏览器，排查完请务必取消勾选**。

执行位置与语义：

- **与 DevTools console 同权限**：**能读到页面自身的 JS 全局变量与内部状态**（`window.__INITIAL_STATE__`、Vue/React 内部对象等）——这正是普通元素命令读不到、需要 exec 的原因
- **代码语义 = console 求值**：整体间接求值，在全局作用域运行，返回**最后一个语句/表达式的完成值**；末尾是 `return` 的函数表达式等都能求值。`var` 声明会进全局，但 `let`/`const` 不暴露给后续调用——需要共享状态请挂到 `window` 上
- **Promise 自动 await**：完成值是 Promise 时命令等它落定再返回结果（reject 则报错）
- **结果必须 JSON 可序列化**：对象/数组/标量正常返回；循环引用、`BigInt`、`undefined`（转 `null`）等会明确报错——要拿这类内容先在自己代码里转成字符串（如 `JSON.stringify(...)`）
- **运行时/语法错误如实上报**：返回错误（含 message 与堆栈首行），不会伪装成成功
- **注入受限页面**（`chrome://`、Chrome 商店页等）无法注入，返回可读报错

参数：

```json
{"code": "document.title"}                       // 必填：要执行的 JS 代码字符串
{"code": "1+1", "frame": 0}                      // frame 语义同 scroll：数字序号定向顶层 iframe
{"code": "1+1", "frame": {"url": "editor"}}      // 按 URL 子串定向 iframe（跨域最稳）
```

- `frame` 缺省 = 顶层 frame；`"top"` 明确顶层；数字按顶层 iframe 序号（依赖 content script 的 iframe 列表，未注入时不可用，此时用 `{"url":...}`）；`{"url":"子串"}` 匹配 URL 含子串的首个 frame
- 返回的普通对象/数组支持 `--field` 裁剪；结果在浏览器端组装后经 server 回传，受 server 60s 超时上限约束（单条 exec 跑超过 60s 会超时报错）
- 未启用开关时错误示例：`Error: exec 命令仅用于排查问题，未在插件配置中启用：请在插件配置页…勾选「允许 exec 命令（仅排查问题）」后再试`

## 注意事项

- **找不到元素先 `list_elements`**：别再猜 selector 或挖整页 HTML——先拿元素地图（含生成好的 selector/可见性/accept 等），再挑目标操作。**先看不带 `closed` 的默认结果**（绝大多数元素在里面），仍找不到再加 `{"closed":true}` 查闭包
- **要坐标用 `get_rect`，不要从截图像素反推**：截图 + 找色块 + 猜缩放/偏移的路线依赖「页面上恰好有个位置固定的参照物」这类假设，一处改版就整体失效；`get_rect` 给的是权威几何，且与 `real_click` 同一坐标口径
- **坐标点击后读 `hit` 断言**：`real_click` 返回它实际点到的元素。给坐标的脚本应当核对 `hit.text`/`hit.class` 是否为目标，不符立即中止——静默点到「暂存离开」这类破坏性按钮是真实事故
- **错误码是给脚本看的**：`not-found`（不存在）/ `unreachable-subtree`（存在但不可寻址）/ `cdp-unavailable`（调试通道被占用，多为 DevTools 开着）语义不同，别把它们都当成「再试一次」；CLI 打印为 `Error [code]: message`，并尽量带上「下一步该做什么」
- `upload_file` 会预检 `accept`：文件类型与 input 的 accept 不匹配（如 PNG 注入 `accept="video/*"` 的 input）直接报错，不会静默失败
- `text` 定位会跳过 `<script>`、`<style>`、`<noscript>` 等不可见元素，优先匹配 `<button>`、`<a>`、`<input>`；自动搜索 iframe，返回带命中 frame 的 `url`
- `--field` 对所有返回对象的命令有效（点路径投影，见「_field 过滤」章节），在浏览器端按需采集、出口统一裁剪
- `--field html`（如 `--field "currentTab.html"`）返回该 frame 的**完整 HTML 内容**（服务端与 CLI 原样转发，不会剥离），需抓页面源码时直接用它
- 同一标签页的命令串行执行，前一条完成后下一条才执行，不需要手动等待；**每条命令返回时它的影响已经落地**（见「等影响落地」），不会出现"命令返回了、页面还在变"——脚本顺序写即可，不需要插 sleep
- **读到的文字就是页面上的文字**：不 trim、不折叠、不截断（见「文字口径」）；匹配时放宽为「原样包含 或 折叠空白后包含」
- 点击后如果页面跳转，会自动等待新页面加载完成再返回结果
- `get_text` 对 textarea 返回空（textContent 不含 value），验证 textarea 输入用 `get_page_info --field "currentTab.html"` 抓 HTML 检查
- `get_js_errors` / `clear_js_errors` 聚合所有 frame（含 iframe）的错误，每条带 `source` 定位到具体 frame
- 扩展更新代码后需在 `chrome://extensions` 刷新扩展，且已打开页面需刷新才会重新注入新脚本
