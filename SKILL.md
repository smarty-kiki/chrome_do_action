---
name: cda-chrome-control
description: 通过 cda CLI 控制本机 Chrome 浏览器执行页面操作：打开网页、点击、输入文本、触发事件、富文本排版、上传文件、截图、显示隐藏元素、提取内容、监听 JS 错误、管理标签页。通用浏览器自动化工具，适用于网页后台、CMS、电商、建站、抓取等各种场景。当用户要求"用 Chrome 打开某网页"、"控制浏览器做 XX"、"在网页上填表/发布内容"、"编辑排版网页内容"、"抓取网页内容"、"上传文件"等场景时使用。前置条件：Node.js 18+、本机 Chrome，按"安装"章节完成一次配置。
version: 1.5.1
display_name: cda Chrome 控制
display_name_en: cda Chrome Control
description_zh: 用命令行控制本机 Chrome 浏览器执行通用网页操作（打开/点击/输入/富文本排版/上传/截图/抓取/管理标签页）
description_en: Control local Chrome via CLI for general web operations (open/click/type/paste-rich-text/upload/screenshot/scrape/manage tabs)
visibility: public
---

# cda Chrome 控制 Skill

cda（Chrome Do Action）让你通过命令行驱动本机 Chrome 浏览器执行真实操作：打开网页、点击元素、输入文字、注入富文本排版、上传文件、截图确认、强制显示隐藏菜单。它是 AI 助手"动手"能力的桥梁——AI 通过它操作真实浏览器，复用本机登录态。

## 前置条件

- Node.js 18+（`node -v` 验证）
- 本机 Chrome 浏览器

## 安装（一次性，约 5 分钟）

```bash
# 1. 下载
git clone https://github.com/smarty-kiki/chrome_do_action.git
cd chrome_do_action

# 2. 安装命令行工具依赖（构建产物已在仓库，无需 npm run build）
cd cli
npm install
node dist/cli.js --help   # 验证

# 3. 安装浏览器扩展（dist 已构建好，无需构建）
#    Chrome 打开 chrome://extensions → 开启"开发者模式" → "加载已解压的扩展程序"
#    选择 chrome-extension/dist 目录

# 4. 启动服务（后台常驻）
cd ../server
nohup node dist/server.js --port 12345 > /tmp/cda-server.log 2>&1 &
```

> 在 WorkBuddy 中：本 skill 已内置服务自检——调用 cda 前先 `list`，服务未运行会自动拉起。用户无需手动启动。

## 标准流程

1. **服务自检 + 获取节点 ID**（每次会话先执行）：
   ```bash
   node <项目>/cli/dist/cli.js list
   ```
   输出如 `d1ugtrds  kiki-macbook  ::ffff:192.168.65.1  online 891s`，第一列为节点 ID `<id>`。
   - 若返回空/连接失败：服务未运行，自动拉起
     ```bash
     nohup node <项目>/server/dist/server.js --port 12345 > /tmp/cda-server.log 2>&1 &
     ```
     等 2 秒重试 `list`。仍无节点：Chrome 扩展未连接，提示在扩展弹窗填 `ws://127.0.0.1:12345` 并连接。

2. **执行操作**：
   ```bash
   node <项目>/cli/dist/cli.js send <id> <命令> <tab> [params]
   ```
   - `<tab>`：`current`（当前活跃标签页）或数字 tabId；**所有页面级命令（含 real_click/screenshot）均支持 `current`**，tabId 为空时自动回退当前激活 tab
   - 浏览器命令（open/list_tabs/close_tab/refresh）不需要 tab

## 命令参考

### 浏览器级命令

| 命令 | 用法 | 说明 |
|------|------|------|
| `list` | `cda list` | 列出在线浏览器节点，拿节点 ID |
| `open` | `send <id> open <url>` | 打开 URL（新标签激活），返回 url/title |
| `list_tabs` | `send <id> list_tabs` | 列出所有标签页 |
| `close_tab` | `send <id> close_tab current\|456` | 关闭标签页 |
| `refresh` | `send <id> refresh current` | 刷新页面 |

### 页面级命令

| 命令 | 用法 | 说明 |
|------|------|------|
| `click` | `send <id> click <tab> '{"selector":"#id"}'` 或 `'{"text":"登录"}'` 或 `'{"x":100,"y":200}'` | 点击元素（selector/CSS/XPath/text/坐标）；**自动搜索 iframe**（顶层优先，含跨域），可加 `frame` 指定 |
| `real_click` | `send <id> real_click <tab> '{"selector":"#submit"}'` | 真实点击，对合成事件免疫的站点有效（click 提示"点到了"却没触发时用它）；iframe（含跨域）同样可点。可选 `approach`：渐进移动路径 `[[x,y],...]`，先移向触发点再点目标，模拟多级 hover（悬停才展开的嵌套菜单/工具条） |
| `type` | `send <id> type <tab> '{"selector":"#title","text":"标题"}'` | 输入文本：**文字原样插入，不加工不拆分**——input/textarea 直接写入，富文本编辑区整段原样插入（进去后怎么分段/排版由页面编辑器自己决定，cda 不做编辑器适配）。`mode` 可选：`replace`（默认，清空原内容）/`append`（追加到末尾）/`insert`（光标处插入，有选中则替换选区）；要分段就一段发一次 |
| `keyboard` | `send <id> keyboard <tab> '{"selector":"#title","key":"Enter"}'` | 向元素发送按键（keydown/keypress/keyup，合成事件）；selector 省略用当前聚焦元素；支持 `ctrl`/`shift`/`alt`/`meta` 组合键 |
| `trigger` | `send <id> trigger <tab> '{"selector":"#username","event":"blur"}'` | 触发元素事件：`blur` 触发表单校验、`change`+`value` 选下拉选项（React 受控组件同样生效）、自定义事件；`focus`/`blur` 触发真实焦点转移（表单校验生效）；带 settle + waitFor；`{options}` 透传事件属性 |
| `paste_rich` | `send <id> paste_rich <tab> '{"selector":".rich-editor","html":"<section>..."}'` | 向富文本编辑区注入带样式 HTML（`mode` 同 type：默认 `replace` 先清空再粘贴，`append`/`insert` 可选），等价粘贴排好版的文档 |
| `upload_file` | `send <id> upload_file <tab> '{"selector":"input[type=file]","base64":"...","filename":"a.jpg","mime":"image/jpeg"}'` | base64 图片注入 file input，触发 change 上传；注入前预检 accept（类型不匹配直接报错，不静默失败） |
| `upload_dragdrop` | `send <id> upload_dragdrop <tab> '{"selector":".upload-area","data":{"base64":"...","filename":"a.jpg","mime":"image/jpeg"}}'` | 向无 file input、只认拖拽的上传区拖入文件，派发 dragenter/dragover/drop；`data` 支持 base64 或 `{url}` |
| `show` | `send <id> show <tab> '.toolbar-menu'` | 强制显示隐藏元素（仅改 CSS：visibility/opacity/display），让 hover 菜单常驻可见后可点击 |
| `hide` | `send <id> hide <tab>` | 还原所有被 show 的元素（清 inline style 回 CSS 控制） |
| `get_text` | `send <id> get_text <tab> [selector]` | 获取文本（无 selector 取整页；带 selector 自动搜索 iframe） |
| `get_css` | `send <id> get_css <tab> <selector>` | 获取元素 computed style |
| `get_prop` | `send <id> get_prop <tab> '{"selector":"#title","prop":"value"}'` | 读取元素属性的**真实原值**（只读，从不调用方法）：`value` 校验输入写入、`checked` 看勾选态、`innerHTML`/`src`/`className` 等任意属性；标量原样返回，无法无损转 JSON 的对象明确报错而非静默变空 |
| `get_page_info` | `send <id> get_page_info <tab>` | 页面信息（url/title/iframes），支持 --field；iframes 对**跨域也补全 url/html** |
| `list_elements` | `send <id> list_elements <tab> '{"filter":"upload","visible":true}'` | **页面元素地图**：列出可交互元素（生成好的 selector/可见性/坐标/accept 等），支持 filter/text/max/visible；穿透 shadow DOM，缺省聚合所有 frame（元素带 frame url）；找不到元素先查它 |
| `screenshot` | `send <id> screenshot <tab> '{"path":"/tmp/shot.png"}'` | 截图（只读），操作前确认页面真实状态 |
| `get_js_errors` | `send <id> get_js_errors <tab>` | 获取页面 JS 报错（跨所有 frame 聚合，每条带 `source` 定位来源 frame） |
| `clear_js_errors` | `send <id> clear_js_errors <tab>` | 清空已收集的 JS 报错，配合 get_js_errors 重新计数 |
| `scroll` | `send <id> scroll <tab> '{"y":500}'` | 滚动页面：无 selector 滚窗口/iframe（`frame` 参数指定）；`{"selector":"..."}` 滚到元素（可滚动容器内滚、普通元素 scrollIntoView，穿透 shadow） |
| `exec` | `send <id> exec <tab> '{"code":"document.title"}'` | ⚠ **仅排查问题使用（高风险，勿当常规手段）**：在页面主世界执行任意 JS 并返回结果，能读页面自身 JS 全局变量。需要先在插件配置页勾选「允许 exec 命令（仅排查问题）」（默认关闭），未启用即被拒绝报错。常规操作一律用上面具体命令（click/get_prop/list_elements 等），不要用 exec 注入任意代码替代 |

### 关键技巧

1. **找不到元素先 `list_elements`**：别猜 selector、别挖 MB 级 HTML。先 `list_elements` 拿元素地图——返回每条元素带生成好的 `selector`（可直接喂给 click/type/upload_file）、可见性、坐标、`accept` 等关键属性。想找上传控件用 `'{"filter":"upload"}'`（同时列出多个 file input 时用 accept 对比选目标，如抖音视频/图文两个 tab）；被 CSS 隐藏的输入框用 `'{"visible":false}'`；shadow DOM 内元素同样列出（selector 带 `>>>`）。多 file input 页面配 `--field "elements.accept,elements.selector"` 快速对比。
2. **等影响落地（settle）**：click/type/keyboard/trigger/upload_file/upload_dragdrop/paste_rich/scroll/real_click 返回前会事件驱动地等影响落地（DOM 变化/长任务，非固定 sleep），返回 `settledMs`。影响落地晚（服务端请求后才渲染、长 debounce）时加 `waitFor` 谓词：`'{"selector":"#btn","waitFor":{"text":"发布成功"}}'`——50ms 轮询、条件满足瞬间返回 `{"settled":true,"waited":615}`。后台 tab 的 Chrome 定时器节流会让 settle 追加 ~1s 确认期，深度后台等不到就用 waitFor 或把 tab 切前台。**任何命令都有 60 秒硬超时**（服务端截断）——单条命令别做分钟级等待，大任务拆小。
3. **坐标必须截图确认**：先 `screenshot` 看真实页面，再取坐标定位。
4. **hover 菜单用 show 解决**：触发不了 hover 时别硬怼事件模拟，`show` 强制显示元素后普通 `click` 即可命中。操作完 `hide` 还原。确需真实 hover 链（如悬停才展开的嵌套菜单）时，用 `real_click` 的 `approach` 渐进路径逐级触发。
5. **iframe 自动搜索**：元素命令默认顶层优先搜遍所有 iframe（含跨域），返回带命中 `frame.url`。目标在 iframe 内且自动搜索未命中时，加 `frame` 参数固定：`{"selector":"...","frame":{"url":"子串"}}`（跨域最稳）或 `{"frame":0}`（第 N 个顶层 iframe）。
6. **shadow DOM 自动穿透**：Web Components 站点（小红书后台等）的按钮/编辑器在 shadow root 里，普通选择器找不到。三种方式：① 直接粘贴 DevTools 元素路径（含 `#shadow-root` 标记）；② `selector: "xhs-publish-btn >>> button"`（`>>>` 穿透所有层）；③ 裸选择器/xpath/text 会自动兜底搜索 open shadow root。closed root 只能用坐标 `real_click {"x":..,"y":..}`。`get_page_info --field html` 默认含 shadow 内容（`<template shadowrootmode="open">` 内联）。
7. **paste_rich 传参**：HTML 含英文引号时 shell 单引号会截断参数，用 Node `spawnSync`（参数数组，不经 shell）传参。
8. **富文本输入**：用 `type` 输入纯文本时文字**原样插入、不自动分段**——要分段就逐段发（后续 `mode:"append"` 追加）；要带格式的排版直接用 `paste_rich` 粘贴排好版的 HTML——块级结构由编辑器自己解析分段。看返回值 `pipeline` 判断落地情况：`"editor_paste"` = 编辑器接管（预期值）；`"default_paste"` = 内容以纯文本进入；`"insertHTML_fallback"` = HTML 原样进入（富文本编辑器出现此值说明它没处理这次粘贴，可能不分段）。cda 不做任何编辑器适配，最终效果由编辑器自己决定，某种编辑器行不行由使用者自行验证。
9. **登录态**：直接复用本机已登录浏览器，无需处理 cookie。
10. **发送按键**：表单提交/关闭弹窗/方向键导航等，用 `keyboard` 向目标元素发键：`send <id> keyboard current '{"selector":"#title","key":"Enter"}'`；组合键加 `ctrl`/`shift` 等布尔参数。合成事件触发页面 keydown 处理器，但不会触发浏览器原生默认行为（如原生表单提交、Tab 切换焦点）。
11. **--field 精确取结果**：所有返回对象的命令都支持 `--field` 点路径裁剪：`--field "clickDesc.selector,settledMs,currentTab.url"` → `{clickDesc:{selector},settledMs,currentTab:{url}}`；`--field "newTabs.url"` → `{newTabs:[url,...]}`。只取需要字段，减少输出、加快响应（不采集未请求的页面信息）。`get_text` 返回纯文本、`get_prop` 标量值原样返回——均无字段可滤（`get_prop` 对象值可裁剪）。
12. **点击要看可点性报告**：`click` 返回的 `clickDesc` 会报告"点不点得到"：`visible: false` = 元素隐藏/无尺寸；`coveredBy: {tag, class, text}` = 目标点被别的元素盖住（浮层/遮罩）；`offscreen: true` = 目标点在视口外。出现这些即说明**合成点击大概率没被页面真正收到**（命令仍返回成功，别被误导）——先 `screenshot` 看真实状态：隐藏的确认加载完或先 `show`，被盖的关掉浮层或配 `waitFor` 等它消失，仍不行用 `real_click` 坐标。
13. **只读校验用 `get_prop`**：type/trigger 后确认真的写入：`get_prop '{"selector":"#title","prop":"value"}'` 看输入值、`'{"selector":"#agree","prop":"checked"}'` 看勾选态、`'{"selector":".rich-text","prop":"innerHTML"}'` 读原始内容。从不执行方法；无法无损转 JSON 的对象会明确报错——需要这类内容改读字符串属性或用 get_text。

## 实战：通用页面操作流程（填表/发布/上传类任务通用）

任何"打开页面 → 填内容 → 提交"类任务（内容后台、建站工具、电商商品、OA 系统等）都按这个套路走，下面示例中的 selector 换成目标页面的实际元素即可（拿不准先用 `list_elements` 拿元素地图，别猜）：

```bash
CLI="node <项目>/cli/dist/cli.js"
NODE=$($CLI list | awk '{print $1}')
TAB=current

# 1. 直达页面（URL 直达比层层点击可靠）
$CLI send $NODE open "https://example.com/admin/post/edit"

# 2. 输入标题（普通输入框直接 type，文字原样写入）
$CLI send $NODE type $TAB '{"selector":"#title","text":"文章标题"}'

# 3. 排版正文：已排好版的 HTML 用 paste_rich 粘贴（带样式）；纯文本用 type，
#    要分段就 mode:"append" 逐段追加
$CLI send $NODE paste_rich $TAB '{"selector":".rich-editor","html":"<section>...</section>"}'

# 4. 上传图片：有 file input 用 upload_file；只有拖拽区用 upload_dragdrop
$CLI send $NODE upload_file $TAB '{"selector":"input[type=file]","base64":"<b64>","filename":"cover.jpg","mime":"image/jpeg"}'

# 5. 提交前截图确认真实状态，再用 get_text/get_prop 校验关键内容（不盲交）
$CLI send $NODE screenshot $TAB '{"path":"/tmp/before-submit.png"}'
$CLI send $NODE get_prop $TAB '{"selector":"#title","prop":"value"}'

# 6. 提交
$CLI send $NODE click $TAB '{"text":"保存"}'
```

这套链路覆盖了最常见的需求：URL 直达、填输入框、富文本粘贴、文件上传、提交前校验。站点换了套路不变；hover 才出现的菜单/工具条加一步 `show` 即可（见技巧 4）。

## 注意事项

- 节点 ID 每次连接会变，操作前必须 `list` 获取
- 扩展重载后节点 ID 变化、旧页面需刷新才注入新脚本
- 服务默认 `ws://127.0.0.1:12345`，本地无需 `--server` 参数
- Chrome 顶部"正在调试此浏览器"横幅为 debugger 能力提示，瞬间消失
- **不要用 `exec` 跑任意 JS 当通用手段**：常规流程用具体命令（click/type/get_prop/list_elements/screenshot 等）足够；只有排查页面问题时才考虑 `exec`，且必须先确认插件配置已勾选「允许 exec 命令」——它在页面主世界执行任意代码，能读取/修改页面一切数据，仅排查问题临时开启，用完关闭
