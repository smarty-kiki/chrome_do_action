// 主世界 JS 错误捕获（manifest content_scripts world:"MAIN" + run_at:"document_start" 注入）。
// 为什么需要：普通 content script 跑在隔离世界，其 window.onerror / unhandledrejection
// 只能看到隔离世界自身的错误——页面主世界脚本抛的运行时错误（真实页面错误）一个都收
// 不到（e2e l2 实测 get_js_errors 恒空）。本脚本在页面最早阶段挂到主世界。
// 跨世界通道：DOM CustomEvent（__cda_js_error__）。曾试过把错误暂存进
// documentElement 上的 expando 数组供 content script 读取——实测 expando 属性每个
// 世界各自持有一份（主世界写入、隔离世界读不到，get_prop 报 No property），不可行。
// DOM 事件能跨世界到达 content script 的 document 监听器，是可靠通道。
// 时序：content script 到 document_idle 才注入，早于它的页面错误先进本地缓冲；
// content script 注入后派发 __cda_js_error_sync__ 请求，本脚本收到即同步补发缓冲
// （先置 synced 再取走缓冲：补发期间新错误直接实时派发，不漏不重）。
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
