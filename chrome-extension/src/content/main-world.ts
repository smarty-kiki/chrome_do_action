// 主世界脚本（manifest content_scripts world:"MAIN" + run_at:"document_start" + all_frames 注入）。
// 为什么需要主世界：普通 content script 跑在隔离世界，其 window.onerror 只能看到隔离世界自身
// 的错误、事件拦截也拦不住页面（隔离世界派发的 stop 传不进页面世界的派发）。这里做四件必须
// 贴着页面的事：
// ⚠ 方向性注意（v0.19.0 实证）：「隔离世界 stop 拦不住页面」正确，但反过来「主世界 stop
// 不影响隔离世界」错误——主世界捕获监听 stopImmediatePropagation 会把同一物理事件在隔离
// 世界的派发一并掐掉（调试拦截段有完整说明与对策，勿再以「各世界独立」为设计前提）。
//   1. JS 错误捕获（__cda_js_error__ 中继给隔离世界 content script）；
//   2. 调试模式 ⌘+]/Ctrl+] 全局快捷键（页面最早注册，早于任何页面脚本，可拦停）；
//   3. 调试模式选择期的页面事件拦截 + frame-chain 定位 oracle；
//   4. 页面动作总线：paste_rich 合成粘贴派发 + set_cursor/get_cursor 光标读写——合成粘贴
//      的浏览器默认行为只在主世界派发时生效，编辑器只认主世界放置的 DOM 光标/选区；
//      详见文件底部同节。
// 跨世界通道：DOM CustomEvent。detail 只允许纯数据（跨世界结构化克隆，DOM 节点传不过去）。
// 注意：MAIN 世界注入的内容脚本拿不到 chrome.* API（那是隔离世界的特权），
// 本文件只允许用 window / document，不能 import 任何扩展模块。

type MainJsError = { message: string; source: string; lineno?: number; colno?: number };

const EVT = "__cda_js_error__";
const SYNC_EVT = "__cda_js_error_sync__";
const MAX = 200;

const buffer: MainJsError[] = [];
let synced = false;

function emit(e: MainJsError): void {
  try {
    document.dispatchEvent(new CustomEvent<MainJsError>(EVT, { detail: e }));
  } catch {
    // 派发失败（页面劫持 dispatchEvent 等极端情况）——丢弃，绝不干扰页面
  }
}

function record(e: MainJsError): void {
  if (!synced) {
    buffer.push(e);
    if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  }
  emit(e);
}

let inHandler = false;

// 捕获器自身绝不能抛错：异常会再次触发 error 事件造成递归/刷屏，还可能在
// 页面自己的错误处理之前先执行——吞掉并只记录原始错误
function safeRun(fn: () => void): void {
  if (inHandler) return;
  inHandler = true;
  try {
    fn();
  } catch {
    // 静默：捕获器故障不打扰页面
  } finally {
    inHandler = false;
  }
}

window.addEventListener(
  "error",
  (ev: Event) => {
    safeRun(() => {
      // 只收脚本运行时错误（ErrorEvent）；资源加载失败（img/script 404 等）在
      // window 上以普通 Event 派发、无 message——收进来全是噪音，跳过
      if (!(ev instanceof ErrorEvent)) return;
      record({ message: ev.message, source: ev.filename, lineno: ev.lineno, colno: ev.colno });
    });
  },
  true,
);

window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
  safeRun(() => {
    const reason = ev.reason;
    const msg = typeof reason === "string" ? reason : (reason && (reason as { message?: unknown }).message) ?? String(reason);
    record({ message: `Unhandled rejection: ${msg}`, source: "unhandledrejection" });
  });
});

// content script 注入完成后的补发请求（document_start 即挂监听，请求必然晚于本监听）
document.addEventListener(SYNC_EVT, () => {
  safeRun(() => {
    if (synced) return;
    synced = true;
    const pending = buffer.splice(0, buffer.length);
    for (const e of pending) emit(e);
  });
});

// ============================ 调试模式（v0.19.0） ============================
// 键盘事件只派发到「当前获得焦点的 frame」。⌘+] 可能按在任意 frame（含页面输入框内，
// 用户已确认要全局拦截）——所以每个 frame 的主世界都注册捕获；顶层直接在自己 document
// 派发 toggle 事件，非顶层 frame 转发到 window.top.document（同源页面 JS 可达）。
// 顶层 document 上收到带 {viaChild:true} 的转发后重新派发一个无 detail 的 toggle——
// 隔离世界（debug-mode.js）只响应无 detail 的 toggle，保证任何路径都恰好触发一次。
// 以下全部包在 IIFE 内：本文件以普通 <script> 形式注入页面主世界，顶层 const/function
// 会落进页面全局作用域，与页面脚本同名声明会互相冲突破坏页面——必须收进函数作用域。

(() => {
const TOGGLE_EVT = "__cda_debug_toggle__";
const INTERCEPT_EVT = "__cda_debug_intercept__";
const GEO_EVT = "__cda_debug_geo__";
const GEO_REPLY_EVT = "__cda_debug_geo_reply__";
// 选择期页面点击 / Esc 拦停后的中继事件（隔离世界 debug-mode.js 收）：
// 主世界的 stopImmediatePropagation 会把同一物理事件的隔离世界派发一并掐掉（见下方实证
// 注释），隔离世界只能收到这里「拦停后新派发」的事件。
const PICK_EVT = "__cda_debug_pick__";
const ESC_EVT = "__cda_debug_esc__";

// 拦截状态由隔离世界 content script（debug-mode.js）在切换选择模式/开关面板时下发
let interceptState: { picking: boolean; iso: boolean } = { picking: false, iso: false };

const isToggleKey = (e: KeyboardEvent): boolean =>
  e.code === "BracketRight" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.repeat;

window.addEventListener(
  "keydown",
  (ev: KeyboardEvent) => {
    safeRun(() => {
      if (!isToggleKey(ev)) return;
      // stopImmediatePropagation：同节点上比本监听注册更晚的页面捕获监听也一并拦掉
      ev.stopImmediatePropagation();
      ev.preventDefault();
      const evt = () => document.dispatchEvent(new CustomEvent(TOGGLE_EVT));
      const top = window.top;
      if (top === null || top === window) {
        evt();
      } else {
        try {
          // 非顶层：转发到顶层 document（同源必然可达；跨域顶层 document 不可达→try 内
          // 抛错，快捷键在此类 frame 内不可用——已确认的已知边界）
          top.document.dispatchEvent(new CustomEvent(TOGGLE_EVT, { detail: { viaChild: true } }));
        } catch {
          // 跨域隔离：放弃
        }
      }
    });
  },
  true,
);

// 顶层主世界接收子 frame 转发，重新派发无 detail 的 toggle（只处理带 viaChild 的，
// 自己按 ⌘+] 直接派发的 plain 事件不会再次进入本分支 → 无死循环）
document.addEventListener(TOGGLE_EVT, (ev: Event) => {
  safeRun(() => {
    const detail = (ev as CustomEvent).detail as { viaChild?: boolean } | undefined;
    if (!detail || !detail.viaChild) return;
    document.dispatchEvent(new CustomEvent(TOGGLE_EVT));
  });
});

// —— 页面事件拦截：隔离世界调试浮层（debug-mode.js）下发状态，本世界负责真正拦停页面 ——
// 【实证结论 · v0.19.0 修正】同一物理事件跨世界在同一派发序列内先后派发，本世界（主世界，
// document_start 最早注册）捕获监听里的 stopImmediatePropagation 会把同序列**后续世界**
// （含隔离世界的 picker/面板监听）一并掐掉；而 preventDefault 不影响其他世界的派发。
// 旧注释「各世界独立派发、stop 不影响隔离世界」与实测相反，曾被当作设计前提——三条用户
// bug（点选完成不了 / × 关不掉 / Esc 无效）全部由此而来。据此定下两条铁律：
//   1. 面板宿主（[data-cda-debug-host] 路径）上的事件一律不拦（面板 ×/按钮/输入框依赖
//      隔离世界原生事件才能工作；页面能听到面板区域点击是此取舍的代价）；
//   2. 选择期必须吞掉的页面事件（页面区点击、Esc），拦停后**新派发**一个 CustomEvent
//      把事件中继进隔离世界——fresh event 从零开始派发，不受 stop 状态影响（方向与仓库
//      既有错误中继一致，实测可达）。
const POINTER_TYPES = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
] as const;

const hitsHost = (ev: Event): boolean =>
  ev.composedPath().some((n) => n instanceof Element && n.hasAttribute("data-cda-debug-host"));

const relayDebug = (type: string, detail: unknown): void => {
  try {
    document.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {
    // 页面劫持 dispatchEvent 等极端情况：中继失败 = 调试交互失效，绝不影响页面
  }
};

const pointerGuard = (ev: Event): void => {
  if (!interceptState.picking) return; // 非选择期一律放行（面板期也不拦，见铁律 1）
  if (hitsHost(ev)) return; // 面板自身交互放行（见铁律 1）
  ev.stopImmediatePropagation();
  ev.preventDefault();
  if (ev.type === "click") {
    // 页面区 click 已吞：隔离世界 picker 的 click 监听同样收不到（见实证结论），
    // 中继点击坐标（clientX/Y 是本帧口径，同帧 picker 消费）
    const me = ev as MouseEvent;
    relayDebug(PICK_EVT, { x: me.clientX, y: me.clientY });
  }
};

for (const type of POINTER_TYPES) {
  window.addEventListener(type, (ev: Event) => safeRun(() => pointerGuard(ev)), true);
}

const keyGuard = (ev: KeyboardEvent): void => {
  // 浮层可见（选择期或面板开）期间 Esc 归浮层：取消/关闭的语义由隔离世界决定
  if (!(interceptState.picking || interceptState.iso)) return;
  if (ev.key !== "Escape" || ev.repeat) return;
  // 页面与隔离世界的 Esc 监听都会被本 stop 掐掉 → 中继。
  // detail.host = 焦点是否在面板内（隔离世界据此区分「取消参数输入行」与「关闭浮层」）
  ev.stopImmediatePropagation();
  ev.preventDefault();
  if (ev.type === "keydown") relayDebug(ESC_EVT, { host: hitsHost(ev) });
};

window.addEventListener("keydown", (ev: KeyboardEvent) => safeRun(() => keyGuard(ev)), true);
window.addEventListener("keyup", (ev: KeyboardEvent) => safeRun(() => keyGuard(ev)), true);

// 状态/请求下发（隔离世界 → 本世界）。仓库已验证的跨世界方向是「主世界派发 → 隔离世界收」
// （错误中继）；反向无先例可依 → debug-mode.js 侧双通道投递（document CustomEvent +
// window.postMessage），本文件两个入口都接，处理幂等（intercept 覆盖写）/重复无害。
const MAIN_MSG = "__cdaMain";

// 拦截状态：{picking: boolean, iso: boolean}
const applyIntercept = (detail: unknown): void => {
  const d = detail as { picking?: boolean; iso?: boolean } | undefined;
  if (!d) return;
  interceptState = { picking: !!d.picking, iso: !!d.iso };
};

// —— frame-chain / 视口偏移 oracle（调试模式选择 iframe 内元素用）——
// 隔离世界 content script 被限制在本 frame 文档内（读不到父 frame 文档），主世界同源页面
// JS 没有此限制。debug-mode.js 在非顶层 frame 选元素时需要两样东西：
//   chain：本 frame 到顶层的逐跳 iframe 定位（每层「父文档 iframe 的 DOM 序号 + 该层 url」），
//          service worker 据此把后续动作路由回本 frame；
//   ox/oy：本 frame 视口原点相对顶层视口的偏移（坐标换算成顶层口径，真实点击按此派发）。
// 同源链上 window.frameElement 可见；任一跳跨域 → frameElement 为 null / 取 rect 抛
// SecurityError → 回 crossOrigin（跨域 frame 内不可选，与产品范围一致）。
// 回复双通道（CustomEvent + postMessage）投递回隔离世界；debug-mode.js 的 GeoClient 只消费
// 第一份（按 requestId），并带超时兜底。
const applyGeoRequest = (reqDetail: unknown): void => {
  const req = reqDetail as { requestId?: number } | undefined;
  if (!req || typeof req.requestId !== "number") return;
  const reply = (detail: unknown) => {
    const payload = { requestId: req.requestId, ...(detail as object) };
    document.dispatchEvent(new CustomEvent(GEO_REPLY_EVT, { detail: payload }));
    try {
      window.postMessage({ [MAIN_MSG]: GEO_REPLY_EVT, detail: payload }, "*");
    } catch {
      // 忽略：回复以 CustomEvent 通道为主
    }
  };
  const hops: { index: number; url: string }[] = [];
  let ox = 0;
  let oy = 0;
  let w: Window = window;
  let blocked = false;
  try {
    while (w !== window.top) {
      const fe = w.frameElement;
      // 本 frame 或某层祖先与它的宿主文档跨域 → frameElement 为 null，链不可建
      if (!fe) {
        blocked = true;
        break;
      }
      const rect = (fe as HTMLElement).getBoundingClientRect();
      const doc = fe.ownerDocument;
      const frames = doc.querySelectorAll("iframe");
      let index = -1;
      for (let i = 0; i < frames.length; i++) {
        if (frames[i] === fe) {
          index = i;
          break;
        }
      }
      // iframe 元素在父文档 DOM 外（极端挂载态）→ 放弃
      if (index < 0) {
        blocked = true;
        break;
      }
      // 链按「顶层→深层」顺序入列，service worker 逐跳解析
      hops.unshift({ index, url: w.location.href });
      ox += rect.left;
      oy += rect.top;
      w = w.parent;
    }
  } catch {
    blocked = true;
  }
  if (blocked) {
    reply({ ok: false, crossOrigin: true });
  } else {
    reply({ ok: true, chain: hops, ox: Math.round(ox), oy: Math.round(oy) });
  }
};

document.addEventListener(INTERCEPT_EVT, (ev: Event) => safeRun(() => applyIntercept((ev as CustomEvent).detail)));
document.addEventListener(GEO_EVT, (ev: Event) => safeRun(() => applyGeoRequest((ev as CustomEvent).detail)));

// postMessage 回退通道：隔离世界的双通道投递中，message 事件必然跨世界到达
window.addEventListener("message", (ev: MessageEvent) => {
  safeRun(() => {
    const data = ev.data as { [MAIN_MSG]?: string; detail?: unknown } | undefined;
    if (!data || typeof data !== "object" || typeof data[MAIN_MSG] !== "string") return;
    if (data[MAIN_MSG] === INTERCEPT_EVT) applyIntercept(data.detail);
    else if (data[MAIN_MSG] === GEO_EVT) applyGeoRequest(data.detail);
  });
});

})();

// ==================== 页面动作总线（主世界执行） ====================
// 为什么必须在主世界（两则实证）：
//   1. 合成 paste：浏览器默认粘贴行为只对「主世界派发」生效（v0.24 实证）——从隔离世界派发
//      同一事件，编辑器监听能收到但默认行为不触发，paste_rich 恒落 execCommand 直插不分段。
//   2. 编辑器光标：Slate 等编辑器只认主世界放置的 DOM 光标/选区——隔离世界放置的光标编辑器
//      模型不同步（v0.25 实证），set_cursor/get_cursor 的落点/读回必须在主世界做。
// content-script 经双通道（document CustomEvent + window.postMessage）把请求中继到这里，
// 一个入口按 action 分发，回复统一 {requestId, action, ok, error?, notFound?, ...payload}
// 双通道回传（隔离世界按 requestId 只消费第一份）。请求 detail 只允许纯数据（DOM 节点
// 跨世界克隆收不下）。
//   action=paste_dispatch {html}      —— 合成粘贴派发。粘贴插入点跟随光标，而选区是帧级
//        共享状态——content-script 已按 mode（replace/append/insert）把光标/选区置入目标
//        编辑区，这里从 document.getSelection() 的 anchor 上溯最近的 contenteditable 宿主
//        即派发目标（与真实 Ctrl+V 的事件目标一致）。
//   action=caret_set {selector, text, [occurrence], [position]}
//                                     —— 按文本串定位光标到目标子串前后/所在行首尾（行模型
//        见下）。不派发任何合成事件：真实 focus + 真实选区变更，selectionchange 由浏览器
//        原生触发，编辑器据此自同步模型。
//   action=caret_get {selector}       —— 读编辑器当前光标：所在行（0 基）/行内逻辑列/行文本
//        （caret_set 之后对账用；选区非折叠时以 anchor 端为准）。
// ⚠ 请求是页面可伪冒的事件（无权限增益——页面本就能自摆光标/自派事件），处理器只做形状
// 校验 + requestId 去重，不鉴权。
(() => {
const MAIN_MSG = "__cdaMain";
const ACTION_EVT = "__cda_main_action__";
const ACTION_REPLY_EVT = "__cda_main_action_reply__";

// —— 请求去重 ——
// 请求双通道（CustomEvent 同步直达 + postMessage 任务投递）会各到一遍：动作有副作用
// （派发粘贴 / 移动光标 / 焦点转移），不能双跑——按 requestId 只执行一次。caret_get
// 只读、双跑无害，但为统一语义也走同一去重。
const seenReq: number[] = [];
const reqSeen = (id: number): boolean => {
  if (seenReq.indexOf(id) >= 0) return true;
  seenReq.push(id);
  if (seenReq.length > 32) seenReq.shift();
  return false;
};

// —— 统一回复（双通道） ——
// 页面劫持 dispatchEvent 的极端情况：CustomEvent 投递失败不阻断 postMessage 通道
const replyAction = (requestId: number, action: string, detail: Record<string, unknown>): void => {
  const payload = { requestId, action, ...detail };
  try {
    document.dispatchEvent(new CustomEvent(ACTION_REPLY_EVT, { detail: payload }));
  } catch {
    // 忽略：postMessage 通道兜底
  }
  try {
    window.postMessage({ [MAIN_MSG]: ACTION_REPLY_EVT, detail: payload }, "*");
  } catch {
    // 忽略
  }
};

// ==================== paste_dispatch 处理 ====================
// 与 content-script 旧实现同款：DataTransfer 带上 text/html（主体）+ text/plain（HTML
// 渲染取文本，供只读纯文本的粘贴处理兜底）；ClipboardEvent 构造器不接收 clipboardData，
// 只能派发前 defineProperty 挂到实例上（合成事件 isTrusted=false 无法伪造，编辑器不校验）
const toPlainText = (markup: string): string => {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-9999px;top:0"; // 不可见但参与渲染，innerText 才能取到块级换行
  probe.innerHTML = markup;
  document.body.appendChild(probe);
  const text = probe.innerText;
  probe.remove();
  return text;
};

const findPasteHost = (): HTMLElement | null => {
  const sel = document.getSelection();
  let node: Node | null = sel && sel.anchorNode ? sel.anchorNode : null;
  // 锚点是 Text/注释等非元素节点：先取宿主元素再上溯；是元素（如空编辑区的锚点即元素本身）
  // 则直接从自己判起
  if (node && node.nodeType !== 1) node = node.parentElement;
  while (node && node.nodeType === 1) {
    const el = node as HTMLElement;
    if (el.isContentEditable) return el;
    node = el.parentElement;
  }
  return null;
};

const applyPasteRequest = (req: { requestId: number; html?: unknown }): void => {
  if (typeof req.html !== "string") {
    replyAction(req.requestId, "paste_dispatch", { ok: false, error: 'Need "html" parameter (a string)' });
    return;
  }
  const host = findPasteHost();
  if (!host) {
    // 定位失败（极端挂载态）回 ok:false，content-script 走兜底直插不回归
    replyAction(req.requestId, "paste_dispatch", { ok: false, error: "光标不在可编辑区（找不到 contenteditable 宿主）" });
    return;
  }
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", toPlainText(req.html));
    dt.setData("text/html", req.html);
    const pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(pasteEvt, "clipboardData", { value: dt });
    host.dispatchEvent(pasteEvt);
    // 派发结束即回传：编辑器是否 preventDefault 已定案，隔离世界据此分 editor_paste /
    // 其余两条（默认行为落地与否由那边比对内容变化判定）
    replyAction(req.requestId, "paste_dispatch", { ok: true, defaultPrevented: pasteEvt.defaultPrevented });
  } catch (e) {
    replyAction(req.requestId, "paste_dispatch", { ok: false, error: (e as Error).message });
  }
};

// ==================== caret_set / caret_get：光标行模型 ====================
// 行（row）= 编辑器根的直接「元素」子级，一行一块：Slate 根子级是各段落块
// （data-slate-node=element）；wangEditor/ProseMirror 常见 <p>/<div> 直接子级。
// 注意本模型的行是「块」不是视觉行：块内软换行（<br>）或嵌套子块拼接时不引入任何分隔符，
// 文本按文档序直连（软换行两侧本就不连续，set_cursor 的文本定位按行内子串，不受影响）。
// 根自身持直接文本节点、或子级不成行（纯 contenteditable 无块结构 / 子级全被排除）时，
// 整树视为单行。
// 行逻辑文本 = 行内贡献文本的 Text 节点 data 按文档序拼接；排除三类不贡献节点：
// script/style/template、contenteditable=false 子树（mention chip 等内嵌只读部件——
// 光标只能停在它们两侧，文本不进逻辑行）、display:none（占位层等不渲染内容）。
// 偏移映射：逻辑列是 JS UTF-16 码元索引（DOM Range 偏移原生 UTF-16，直接 1:1 可算），
// 逐 Text 节点累计成 runs: {node, start, end}，逻辑偏移 ⇄ 「真实 Text 节点 + 节点内
// 偏移」严格互转——span/leaf 把文本拆碎、emoji surrogate、行内元素都不影响正确性，
// 无半字符落点。空行（<p><br></p>，无文本段）的光标落点是元素锚点（行元素 offset 0）。
const POSITIONS = ["before", "after", "start", "end"] as const;
type CaretPosition = (typeof POSITIONS)[number];
type CaretRun = { node: Text; start: number; end: number };
type RowModel = { el: Element; runs: CaretRun[]; text: string };

// 收集 root 下所有 open shadow root（含嵌套，按文档序，每棵一次）。main world 自包含
// 版本——隔离世界 content-script 的 openShadowRootsDeep 语义在此复制一份（编辑器根可能
// 嵌在 Web Components 的 shadow 里，同 findElement 的穿透语义）
const shadowRootsDeep = (root: Document | ShadowRoot | Element = document): ShadowRoot[] => {
  const out: ShadowRoot[] = [];
  const walk = (r: Document | ShadowRoot | Element) => {
    if (r instanceof Element && r.shadowRoot) {
      out.push(r.shadowRoot);
      walk(r.shadowRoot);
    }
    for (const el of Array.from(r.querySelectorAll("*"))) {
      const sr = el.shadowRoot;
      if (sr) {
        out.push(sr);
        walk(sr);
      }
    }
  };
  walk(root);
  return out;
};

// selector → 编辑器根元素。css:/xpath: 前缀与隔离世界 findElement 同语义；light DOM 未命中
// 时按文档序兜底搜所有 open shadow root。只在本 frame 文档内解析——隔离世界按 frame 分发
// 请求，本 frame 无此根时回 notFound，由那边换下一个 frame 再试。
const resolveRoot = (selector: string): Element | null => {
  if (selector.startsWith("xpath:")) {
    const exp = selector.slice(6);
    try {
      const hit = document.evaluate(exp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
        .singleNodeValue as Element | null;
      if (hit) return hit;
    } catch {
      // 非法表达式：落到 shadow 兜底（同样失败 → null）
    }
    for (const sr of shadowRootsDeep()) {
      // ShadowRoot 不能作 XPath context（#document-fragment 非法）：按顶层子元素逐个求值
      for (const child of Array.from(sr.children)) {
        try {
          const hit = document.evaluate(exp, child, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
            .singleNodeValue as Element | null;
          if (hit) return hit;
        } catch {
          // 绝对路径（/html/…）在 shadow tree 内无意义，跳过
        }
      }
    }
    return null;
  }
  const css = selector.startsWith("css:") ? selector.slice(4) : selector;
  try {
    const direct = document.querySelector(css);
    if (direct) return direct;
  } catch {
    // 非法选择器：落到 shadow 兜底（同样失败 → null）
  }
  for (const sr of shadowRootsDeep()) {
    try {
      const el = sr.querySelector(css);
      if (el) return el;
    } catch {
      // 同上
    }
  }
  return null;
};

// 元素/文本是否处于「不贡献行文本」的子树内（上溯到行元素为止）：script/style/template、
// contenteditable=false 子树、display:none。爬的每一层都判——被排除属性可能出现在任意深度
const excludedFromRow = (node: Node, row: Element): boolean => {
  let cur: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
  while (cur && cur !== row) {
    const tag = cur.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return true;
    if (cur.getAttribute("contenteditable") === "false") return true;
    try {
      if (getComputedStyle(cur).display === "none") return true;
    } catch {
      // 断连元素等极端态：跳过样式判定
    }
    cur = cur.parentElement;
  }
  return false;
};

// 行元素资格：非 script/style/template、非 contenteditable=false、非 display:none——
// 被排除的直接子级（占位层、只读块）不构成行
const rowQualified = (el: Element): boolean => {
  const tag = el.tagName;
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return false;
  if (el.getAttribute("contenteditable") === "false") return false;
  try {
    if (getComputedStyle(el).display === "none") return false;
  } catch {
    // 保留
  }
  return true;
};

// 行列表：正常编辑器根的直接元素子级各为一行；根自身持直接文本 / 没有元素子级 / 子级
// 全被排除（纯 contenteditable 无块结构）→ 整树单行
const buildRows = (root: Element): Element[] => {
  for (const n of Array.from(root.childNodes)) {
    if (n.nodeType === 3 && (n as Text).data.length > 0) return [root];
  }
  const rows: Element[] = [];
  for (const el of Array.from(root.children)) {
    if (rowQualified(el)) rows.push(el);
  }
  return rows.length > 0 ? rows : [root];
};

// 全模型：每行的 runs（文本段累计）与逻辑文本
const modelOf = (root: Element): RowModel[] => {
  return buildRows(root).map((el) => {
    const runs: CaretRun[] = [];
    let pos = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = n as Text;
      if (t.data.length === 0 || excludedFromRow(t, el)) continue;
      runs.push({ node: t, start: pos, end: pos + t.data.length });
      pos += t.data.length;
    }
    return { el, runs, text: runs.map((r) => r.node.data).join("") };
  });
};

const rowLen = (m: RowModel): number => (m.runs.length === 0 ? 0 : m.runs[m.runs.length - 1].end);

// 全文档序扫描 text 子串，数到第 occurrence 次命中（indexOf 语义，重叠命中也算——
// "aaa" 找 "aa"：位置 0/1/2 三个）。返回命中行模型序号 + 行内起止逻辑列；seen = 实际
// 总出现次数（未命中时供报错，调用方据此改 occurrence）
const findText = (
  model: RowModel[],
  needle: string,
  occurrence: number,
): { found: { rowIndex: number; colStart: number; colEnd: number } | null; seen: number } => {
  let seen = 0;
  for (let i = 0; i < model.length; i++) {
    const line = model[i].text;
    let from = 0;
    let idx = line.indexOf(needle, from);
    while (idx >= 0) {
      seen++;
      if (seen === occurrence) return { found: { rowIndex: i, colStart: idx, colEnd: idx + needle.length }, seen };
      from = idx + 1;
      idx = line.indexOf(needle, from);
    }
  }
  return { found: null, seen };
};

// DOM 边界 (node, offset) 全序比较：-1 = a 在 b 前，0 = 同一边界，1 = a 在 b 后。
// 文本节点 offset 是字符位置；元素节点 offset 是子节点边界（第 offset 个子节点之前）。
// 元素边界与其子树内容的起点是同一位置（(E, i) ≡ (child[i], 0)）——含元素祖先时沿包含
// 链逐层下钻再比。caret_get 用：元素锚点（行元素 / 空行 / 嵌件边缘）与各文本段端点比位置
const cmpPos = (a: { node: Node; offset: number }, b: { node: Node; offset: number }): number => {
  if (a.node === b.node) return a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0;
  const aEl = a.node.nodeType === 1 ? (a.node as Element) : null;
  const bEl = b.node.nodeType === 1 ? (b.node as Element) : null;
  if (aEl && aEl.contains(b.node)) {
    let cur: Node = b.node;
    while (cur.parentNode !== a.node) cur = cur.parentNode as Node;
    const i = Array.prototype.indexOf.call(a.node.childNodes, cur);
    if (a.offset < i) return -1;
    if (a.offset > i) return 1;
    return cmpPos({ node: cur, offset: 0 }, b); // 边界与子树起点同界：下钻到子树内比较
  }
  if (bEl && bEl.contains(a.node)) return -cmpPos(b, a);
  // 无包含关系：上溯到共同祖先，比两棵子树的前后
  let p: Node | null = a.node.parentNode;
  let aChild: Node = a.node;
  while (p && !p.contains(b.node)) {
    aChild = p;
    p = p.parentNode;
  }
  if (!p) return 0; // 不同文档树（本文件只用同文档位置，理论不可达）
  let q: Node | null = b.node.parentNode;
  let bChild: Node = b.node;
  while (q !== null && q !== p) {
    bChild = q;
    q = q.parentNode;
  }
  const ai = Array.prototype.indexOf.call(p.childNodes, aChild);
  const bi = Array.prototype.indexOf.call(p.childNodes, bChild);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
};

// 行内 DOM 边界 → 逻辑列（caret_get 侧）。
// 文本节点锚点：节点在行文本内 → 行内起点 + 节点内偏移（钳位）即逻辑列；不在行文本内
// （被排除子树中的文本，原生光标到不了）→ null，调用方报 inEditor:false。
// 元素锚点（行元素 / 空行 / 嵌套元素 / 嵌件边缘）：边界是子节点边界，不可能切进文本段
// 内部——按行文本序扫各段：段起点在边界后 → 后续各段全不计（break）；段起点早于边界 →
// 整段必在边界前，计入后继续；累加即逻辑列。
const colAt = (runs: CaretRun[], anchor: Node, anchorOffset: number): number | null => {
  if (runs.length === 0) return 0;
  if (anchor.nodeType === 3) {
    for (const run of runs) {
      if (run.node === anchor) {
        return run.start + Math.min(Math.max(anchorOffset, 0), run.node.data.length);
      }
    }
    return null;
  }
  if (anchor.nodeType === 1) {
    const bp = { node: anchor, offset: Math.min(Math.max(anchorOffset, 0), anchor.childNodes.length) };
    let col = 0;
    for (const run of runs) {
      if (cmpPos(bp, { node: run.node, offset: 0 }) <= 0) break; // 边界在段起点或之前：不计
      // 元素边界不会切进文本段内部（文本段对元素边界是原子子级）：段起点早于边界 →
      // 整段必在边界前（边界落段内的理论情形同计），累加后继续扫后面的段
      col += run.node.data.length;
    }
    return col;
  }
  return null;
};

// 逻辑列 → DOM 边界（caret_set 侧）：段内精确落「Text 节点 + 节点内偏移」；行首/行尾/
// 空行落在元素锚点——空行 <p><br></p> 无文本段，用行元素 offset 0（Chrome 光标即渲染在
// 该行行首，<br> 前）
const boundaryAt = (row: Element, runs: CaretRun[], col: number): { node: Node; offset: number } => {
  if (runs.length === 0) return { node: row, offset: 0 };
  if (col <= 0) return { node: runs[0].node, offset: 0 };
  const total = runs[runs.length - 1].end;
  if (col >= total) {
    const last = runs[runs.length - 1];
    return { node: last.node, offset: last.node.data.length };
  }
  for (const run of runs) {
    if (col < run.end) return { node: run.node, offset: col - run.start };
  }
  return { node: row, offset: 0 }; // 不可达
};

const applyCaretSet = (req: { requestId: number; selector?: unknown; text?: unknown; occurrence?: unknown; position?: unknown }): void => {
  const fail = (error: string, extra?: Record<string, unknown>): void =>
    replyAction(req.requestId, "caret_set", { ok: false, error, ...(extra ?? {}) });

  if (typeof req.selector !== "string" || !req.selector) return fail('Need "selector" parameter (a string)');
  if (typeof req.text !== "string" || !req.text) return fail('Need "text" parameter (a non-empty string)');
  const occurrence = req.occurrence === undefined ? 1 : req.occurrence;
  if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 1) {
    return fail(`"occurrence" must be a positive integer (got ${JSON.stringify(req.occurrence)})`);
  }
  let position: CaretPosition = "after";
  if (req.position !== undefined) {
    if (typeof req.position !== "string" || (POSITIONS as readonly string[]).indexOf(req.position) < 0) {
      return fail(`Invalid position: ${JSON.stringify(req.position)} (expected before|after|start|end)`);
    }
    position = req.position as CaretPosition;
  }

  const root = resolveRoot(req.selector);
  if (!root) return fail(`Element not found: ${req.selector}`, { notFound: true });
  // 光标要落进可编辑区才有意义：focus/选区放不进不可编辑区（与 type/paste_rich 同款校验；
  // isContentEditable 含继承——外层容器 CE 时同样通过）
  if (!(root as HTMLElement).isContentEditable) {
    return fail(`Element is not contenteditable: ${req.selector} (tag=${root.tagName.toLowerCase()})`);
  }
  // 真实聚焦 + 真实选区变更，零合成事件：selectionchange 原生触发 → 编辑器自同步模型。
  // 焦点先于选区：编辑器 focus 处理器先跑（同步重渲染也落定），随后在它之后的 DOM 上建模
  // 落点——避免按 focus 前旧 DOM 算出的节点引用因重渲染脱节。聚焦失败不阻断：选区放置
  // 本身会把焦点带进可编辑区
  try {
    (root as HTMLElement).focus();
  } catch {
    // 忽略
  }

  try {
    const model = modelOf(root);
    const { found, seen } = findText(model, req.text, occurrence);
    if (!found) {
      if (seen === 0) return fail(`Text not found in editor: "${req.text}"`);
      return fail(`"${req.text}" appears ${seen} time(s) in the editor; occurrence ${occurrence} does not exist (occurrence starts at 1)`);
    }
    const rowModel = model[found.rowIndex];
    const col =
      position === "start" ? 0
      : position === "end" ? rowLen(rowModel)
      : position === "before" ? found.colStart
      : found.colEnd;
    const boundary = boundaryAt(rowModel.el, rowModel.runs, col);
    const sel = window.getSelection();
    if (!sel) return fail("Selection API unavailable");
    const range = document.createRange();
    range.setStart(boundary.node, boundary.offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    // 回复目标落点：编辑器 normalize/重渲染后光标可能微调，实际位置由 content-script 侧
    // 再发 caret_get 读回（以读回为准）
    replyAction(req.requestId, "caret_set", { ok: true, row: found.rowIndex, col });
  } catch (e) {
    fail(`caret_set failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const applyCaretGet = (req: { requestId: number; selector?: unknown }): void => {
  const fail = (error: string, extra?: Record<string, unknown>): void =>
    replyAction(req.requestId, "caret_get", { ok: false, error, ...(extra ?? {}) });
  const outOfEditor = (): void =>
    replyAction(req.requestId, "caret_get", { ok: true, inEditor: false, row: null, col: null, text: null });

  if (typeof req.selector !== "string" || !req.selector) return fail('Need "selector" parameter (a string)');
  const root = resolveRoot(req.selector);
  if (!root) return fail(`Element not found: ${req.selector}`, { notFound: true });
  const sel = window.getSelection();
  const anchor = sel ? sel.anchorNode : null;
  const anchorOffset = sel ? sel.anchorOffset : 0;
  // 无选区 / 光标在 root 外（焦点在页面别处）/ 锚点类型不可读：如实报 inEditor:false——
  // 不是错误，调用方据此决定先 set_cursor 还是换目标
  if (!anchor || (anchor.nodeType !== 3 && anchor.nodeType !== 1) || !root.contains(anchor)) {
    return outOfEditor();
  }

  try {
    const model = modelOf(root);
    const replyInRow = (rowIndex: number, m: RowModel, col: number | null): void => {
      if (col === null) return outOfEditor(); // 锚点文本在排除子树内：原生光标到不了
      replyAction(req.requestId, "caret_get", { ok: true, inEditor: true, row: rowIndex, col, text: m.text });
    };
    // 单行模式（根即行）：光标在根内任意可编辑处都属于该行
    if (model.length === 1 && model[0].el === root) {
      return replyInRow(0, model[0], colAt(model[0].runs, anchor, anchorOffset));
    }
    // 多行模式：锚点沿祖先链上溯到 root 的直接子级
    let node: Node = anchor;
    while (node !== root && node.parentElement && node.parentElement !== root) {
      node = node.parentElement;
    }
    if (node === root) {
      // 锚点即 root：边界 = 第 k 个直接子级前（k == 子级数 = 越过末子级）。此形态罕见
      // （行内光标通常锚在文本节点或行元素上；多见于编辑器空态/块边界），映射从简但确定：
      //   · 边界落在合格子级上 → 该行行首（行号 = 它前面合格行数）
      //   · 边界落在被排除子级前 / 越过末合格子级 → 前一合格行行尾；没有 → 编辑器起点
      const k = Math.min(Math.max(anchorOffset, 0), root.children.length);
      let qualifiedBefore = 0; // 已扫过的合格行数
      let res: { row: number; col: number } | null = null;
      for (let ci = 0; ci < root.children.length; ci++) {
        const child = root.children[ci];
        if (ci === k) {
          if (rowQualified(child)) {
            res = { row: qualifiedBefore, col: 0 };
          } else if (qualifiedBefore > 0) {
            const r = qualifiedBefore - 1;
            res = { row: r, col: rowLen(model[r]) };
          } else {
            res = { row: 0, col: 0 };
          }
          break;
        }
        if (rowQualified(child)) qualifiedBefore++;
      }
      if (!res) {
        // k 越过末子级：落在最后一行行尾；根下无合格行（不可达，防御）→ 起点
        if (qualifiedBefore > 0) {
          const r = qualifiedBefore - 1;
          res = { row: r, col: rowLen(model[r]) };
        } else {
          res = { row: 0, col: 0 };
        }
      }
      return replyInRow(res.row, model[res.row], res.col);
    }
    // 锚点在 root 的直接子级内：合格子级 → 其行；否则光标在不构成行的内容（占位层等）里
    const rowIndex = model.findIndex((m) => m.el === node);
    if (rowIndex < 0) return outOfEditor();
    return replyInRow(rowIndex, model[rowIndex], colAt(model[rowIndex].runs, anchor, anchorOffset));
  } catch (e) {
    fail(`caret_get failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

// —— 总线入口：按 action 分发（请求形状校验失败回可读错误，不让隔离世界空等超时）——
const applyRequest = (detail: unknown): void => {
  const req = detail as { requestId?: number; action?: string } | undefined;
  if (!req || typeof req !== "object" || typeof req.requestId !== "number") return;
  if (reqSeen(req.requestId)) return; // 双通道第二份/过期重放：丢弃，只执行一次
  if (req.action === "paste_dispatch") applyPasteRequest(req as { requestId: number; html?: unknown });
  else if (req.action === "caret_set") applyCaretSet(req as { requestId: number; selector?: unknown; text?: unknown; occurrence?: unknown; position?: unknown });
  else if (req.action === "caret_get") applyCaretGet(req as { requestId: number; selector?: unknown });
  else replyAction(req.requestId, typeof req.action === "string" ? req.action : "", { ok: false, error: `Unknown action: ${String(req.action)}` });
};

// 请求入口与 debug 通道同构：CustomEvent + postMessage 双入口都接，requestId 去重保证单次
document.addEventListener(ACTION_EVT, (ev: Event) => safeRun(() => applyRequest((ev as CustomEvent).detail)));
window.addEventListener("message", (ev: MessageEvent) => {
  safeRun(() => {
    const data = ev.data as { [MAIN_MSG]?: string; detail?: unknown } | undefined;
    if (!data || typeof data !== "object" || typeof data[MAIN_MSG] !== "string") return;
    if (data[MAIN_MSG] === ACTION_EVT) applyRequest(data.detail);
  });
});
})();
