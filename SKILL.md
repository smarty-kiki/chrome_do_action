---
name: cda-chrome-control
description: 通过 cda CLI 控制本机 Chrome 浏览器执行页面操作：打开网页、点击、输入文本、富文本排版、上传图片、截图、显示隐藏菜单、提取内容、监听 JS 错误、管理标签页。当用户要求"用 Chrome 打开某网页"、"控制浏览器做 XX"、"自动化公众号文章"、"抓取网页内容"、"填表单"等场景时使用。前置条件：Node.js 18+、本机 Chrome，按"安装"章节完成一次配置。
version: 1.2.0
display_name: cda Chrome 控制
display_name_en: cda Chrome Control
description_zh: 用命令行控制本机 Chrome 浏览器（打开/点击/输入/排版/上传/截图/公众号自动化）
description_en: Control local Chrome via CLI (open/click/type/paste/upload/screenshot/WeChat MP automation)
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
cd ../cli
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
     nohup node <项目>/cli/dist/server.js --port 12345 > /tmp/cda-server.log 2>&1 &
     ```
     等 2 秒重试 `list`。仍无节点：Chrome 扩展未连接，提示在扩展弹窗填 `ws://127.0.0.1:12345` 并连接。

2. **执行操作**：
   ```bash
   node <项目>/cli/dist/cli.js send <id> <命令> <tab> [params]
   ```
   - `<tab>`：`current`（当前活跃标签页）或数字 tabId
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
| `real_click` | `send <id> real_click <tab> '{"selector":"#submit"}'` | CDP 真实点击（isTrusted=true），对合成事件免疫的站点（如微信后台）有效；同源 iframe 自动换算坐标，跨域走 CDP 定位 |
| `type` | `send <id> type <tab> '{"selector":"#title","text":"标题"}'` | 输入文本：input/textarea 直接赋值；contenteditable 富文本按 `\n` 分段 |
| `keyboard` | `send <id> keyboard <tab> '{"selector":"#title","key":"Enter"}'` | 向元素发送按键（keydown/keypress/keyup，合成事件）；selector 省略用当前聚焦元素；支持 `ctrl`/`shift`/`alt`/`meta` 组合键 |
| `paste_rich` | `send <id> paste_rich <tab> '{"selector":".ProseMirror","html":"<section>..."}'` | 向富文本编辑器注入带样式 HTML（先清空再插入），等价粘贴排好版的文档 |
| `upload_file` | `send <id> upload_file <tab> '{"selector":"input[type=file]","base64":"...","filename":"a.jpg","mime":"image/jpeg"}'` | base64 图片注入 file input，触发 change 上传 |
| `show` | `send <id> show <tab> '.js_imagedialog'` | 强制显示隐藏元素（仅改 CSS：visibility/opacity/display），让 hover 菜单常驻可见后可点击 |
| `hide` | `send <id> hide <tab>` | 还原所有被 show 的元素（清 inline style 回 CSS 控制） |
| `get_text` | `send <id> get_text <tab> [selector]` | 获取文本（无 selector 取整页；带 selector 自动搜索 iframe） |
| `get_css` | `send <id> get_css <tab> <selector>` | 获取元素 computed style |
| `get_page_info` | `send <id> get_page_info <tab>` | 页面信息（url/title/iframes），支持 --field；iframes 对**跨域也补全 url/html** |
| `screenshot` | `send <id> screenshot <tab> '{"path":"/tmp/shot.png"}'` | CDP 截图（只读），操作前确认页面真实状态 |
| `get_js_errors` | `send <id> get_js_errors <tab>` | 获取页面 JS 报错 |
| `scroll` | `send <id> scroll <tab> '{"y":500}'` | 滚动页面 |

### 关键技巧

1. **坐标必须截图确认**：DOM 快照可能有顶部隐藏模板，get_rect 会返回错误坐标（曾把 y=824 误报成 224）。先 `screenshot` 看真实页面再定位。
2. **hover 菜单用 show 解决**：触发不了 hover 时别硬怼事件模拟，`show` 强制显示元素后普通 `click` 即可命中。操作完 `hide` 还原。
3. **iframe 自动搜索**：元素命令默认顶层优先搜遍所有 iframe（含跨域），返回带命中 `frame.url`。目标在 iframe 内且自动搜索未命中时，加 `frame` 参数固定：`{"selector":"...","frame":{"url":"子串"}}`（跨域最稳）或 `{"frame":0}`（第 N 个顶层 iframe）。
4. **paste_rich 传参**：HTML 含英文引号时 shell 单引号会截断参数，用 Node `spawnSync`（参数数组，不经 shell）传参。
5. **富文本输入**：公众号正文是 ProseMirror（contenteditable），用 `type` 支持富文本；标题 `#title`（textarea）。
6. **登录态**：直接复用本机已登录浏览器，无需处理 cookie。
7. **发送按键**：表单提交/关闭弹窗/方向键导航等，用 `keyboard` 向目标元素发键：`send <id> keyboard current '{"selector":"#title","key":"Enter"}'`；组合键加 `ctrl`/`shift` 等布尔参数。合成事件触发页面 keydown 处理器，但不会触发浏览器原生默认行为（如原生表单提交、Tab 切换焦点）。

## 实战：公众号文章全自动化

端到端链路（已验证跑通）：打开编辑器 → 标题 → paste_rich 排版正文 → 封面（show 方案）→ 保存草稿。

```bash
CLI="node <项目>/cli/dist/cli.js"
NODE=$($CLI list | awk '{print $1}')
TAB=current

# 1. 打开编辑器（URL 直达，比点按钮可靠）
$CLI send $NODE open "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=<TOKEN>&lang=zh_CN"

# 2. 输入标题
$CLI send $NODE click $TAB '{"selector":"#title"}'
$CLI send $NODE type $TAB '{"selector":"#title","text":"文章标题"}'

# 3. 排版正文（paste_rich，HTML 先构建好）
$CLI send $NODE paste_rich $TAB '{"selector":".ProseMirror[style*=\"min-height\"]","html":"<section>...</section>"}'

# 4. 封面：show 显示 hover 菜单 → 点"从图片库选择" → 选图 → 下一步 → 确认 → hide
$CLI send $NODE scroll $TAB '{"x":900,"y":600}'
$CLI send $NODE show $TAB '.js_cover_opr'
$CLI send $NODE show $TAB '.js_imagedialog'
$CLI send $NODE show $TAB '.js_selectCoverFromContent'
$CLI send $NODE show $TAB '.js_imageScan'
$CLI send $NODE show $TAB '.js_aiImage'
$CLI send $NODE click $TAB '{"selector":".js_imagedialog"}'
$CLI send $NODE click $TAB '{"text":"cover_final.jpg"}'
$CLI send $NODE click $TAB '{"text":"下一步"}'
$CLI send $NODE click $TAB '{"text":"确认"}'
$CLI send $NODE hide $TAB

# 5. 保存草稿
$CLI send $NODE click $TAB '{"selector":"#js_submit"}'
```

## 注意事项

- 节点 ID 每次连接会变，操作前必须 `list` 获取
- 扩展重载后节点 ID 变化、旧页面需刷新才注入新脚本
- 公众号未实名认证时 AI 配图受限，封面走"从图片库选择"
- 服务默认 `ws://127.0.0.1:12345`，本地无需 `--server` 参数
- Chrome 顶部"正在调试此浏览器"横幅为 debugger 能力提示，瞬间消失
