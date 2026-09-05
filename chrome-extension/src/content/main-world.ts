// 主世界脚本（manifest content_scripts world:"MAIN" + run_at:"document_start" + all_frames 注入）。
// 为什么需要主世界：普通 content script 跑在隔离世界，其 window.onerror 只能看到隔离世界自身
// 的错误、事件拦截也拦不住页面（隔离世界派发的 stop 传不进页面世界的派发）。这里做三件必须
// 贴着页面的事：
// ⚠ 方向性注意（v0.19.0 实证）：「隔离世界 stop 拦不住页面」正确，但反过来「主世界 stop
// 不影响隔离世界」错误——主世界捕获监听 stopImmediatePropagation 会把同一物理事件在隔离
// 世界的派发一并掐掉（调试拦截段有完整说明与对策，勿再以「各世界独立」为设计前提）。
//   1. JS 错误捕获（__cda_js_error__ 中继给隔离世界 content script）；
//   2. 调试模式 ⌘+]/Ctrl+] 全局快捷键（页面最早注册，早于任何页面脚本，可拦停）；
//   3. 调试模式选择期的页面事件拦截 + frame-chain 定位 oracle。
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
