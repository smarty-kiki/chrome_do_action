// --- Persistent JS error collection ---
// Starts on page load, accumulates errors until explicitly cleared.
// 隔离世界自身错误（window.onerror / unhandledrejection）与主世界错误中继
// （见下方 MAIN_ERROR_EVT 监听）都收进 jsErrors；上限 MAX_JS_ERRORS 防长跑泄漏。

const jsErrors: JsError[] = [];
const MAX_JS_ERRORS = 200;

function pushJsError(e: JsError): void {
  jsErrors.push(e);
  if (jsErrors.length > MAX_JS_ERRORS) jsErrors.splice(0, jsErrors.length - MAX_JS_ERRORS);
}

function onPageError(ev: ErrorEvent) {
  pushJsError({ message: ev.message, source: ev.filename, lineno: ev.lineno, colno: ev.colno });
}

function onUnhandledRejection(ev: PromiseRejectionEvent) {
  const reason = ev.reason;
  const msg = typeof reason === "string" ? reason : reason?.message ?? String(reason);
  pushJsError({ message: `Unhandled rejection: ${msg}`, source: "unhandledrejection" });
}

window.addEventListener("error", onPageError);
window.addEventListener("unhandledrejection", onUnhandledRejection);

// 主世界错误中继（捕获器见 main-world.ts）：页面主世界脚本的运行时错误由注入主世界的
// document_start 脚本以 __cda_js_error__ CustomEvent 派发到 document——DOM 事件是
// 跨世界唯一可靠通道（曾试过把主世界队列暂存到 documentElement 上的 expando 数组，
// 实测 expando 属性每个世界各自持有一份，主世界写入、隔离世界读不到）。
// 时序：本脚本 document_idle 才注入；早于它的页面错误由主世界本地缓冲，注入完成后
// 派发 __cda_js_error_sync__ 请求，主世界收到即同步补发缓冲（监听先挂、后请求）。
const MAIN_ERROR_EVT = "__cda_js_error__";
const MAIN_ERROR_SYNC_EVT = "__cda_js_error_sync__";

function onMainWorldError(ev: Event): void {
  if (!(ev instanceof CustomEvent)) return;
  const d = ev.detail as { message?: unknown; source?: unknown; lineno?: unknown; colno?: unknown } | null;
  // 形状校验：页面理论上可冒用同名事件，只收结构完整、能无损透传的条目
  if (!d || typeof d.message !== "string" || typeof d.source !== "string") return;
  pushJsError({
    message: d.message,
    source: d.source,
    ...(typeof d.lineno === "number" ? { lineno: d.lineno } : {}),
    ...(typeof d.colno === "number" ? { colno: d.colno } : {}),
  });
}

document.addEventListener(MAIN_ERROR_EVT, onMainWorldError);
// 同步请求：主世界同步派发重放，回调栈内即收到早前缓冲的主世界错误
try {
  document.dispatchEvent(new CustomEvent(MAIN_ERROR_SYNC_EVT));
} catch {
  // 页面劫持 dispatchEvent 的极端情况：早于注入的错误拿不到，静默放弃
}

// list_elements 返回的单个元素条目（service worker 聚合时给非顶层 frame 补 frame 字段）
interface ElementInfo {
  tag: string;
  visible: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  selector: string;
  type?: string;
  accept?: string;
  multiple?: boolean;
  name?: string;
  placeholder?: string;
  role?: string;
  ariaLabel?: string;
  title?: string;
  text?: string;
}

// --- show/hide 还原注册表 ---
// show 记录被改元素的原始 inline 样式，hide 或 ttl 到期时精确还原（清掉 inline style 回到 CSS 控制）
const showRegistry = new Map<HTMLElement, { visibility?: string; opacity?: string; display?: string }>();

function restoreShownElement(el: HTMLElement): void {
  const orig = showRegistry.get(el);
  if (!orig) return;
  const restoreProp = (prop: "visibility" | "opacity" | "display", origVal?: string) => {
    if (origVal) {
      el.style.setProperty(prop, origVal);
    } else {
      el.style.removeProperty(prop);
    }
  };
  restoreProp("visibility", orig.visibility);
  restoreProp("opacity", orig.opacity);
  restoreProp("display", orig.display);
  showRegistry.delete(el);
}

// --- Command handler ---

chrome.runtime.onMessage.addListener(
  (msg: { type: string; id?: string; payload: { command: string; params?: Record<string, unknown> } },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (res: { success: boolean; data?: unknown; error?: string; jsErrors?: JsError[] }) => void) => {
    if (msg.type !== "execute_command") return;
    const { command } = msg.payload;
    const fields = ((msg.payload.params?._field) as string[] | undefined) || [];

    const includeJsErrors = fields.includes("jsErrors");
    const exec = () => handleCommand(msg.payload);
    const promise = exec().then((result) => {
      if (includeJsErrors) {
        const all = [...jsErrors];
        if (all.length > 0) {
          const withErrors = { ...result, jsErrors: all };
          if (command === "click") {
            const { jsErrors: _, ...rest } = withErrors;
            return rest;
          }
          return withErrors;
        }
      }
      return result;
    });
    promise.then(sendResponse);
    return true;
  },
);

// --- _field filtering helpers ---

interface JsError {
  message: string;
  source: string;
  lineno?: number;
  colno?: number;
}

function getFieldFilter(params: Record<string, unknown>): string[] {
  return ((params._field as string[] | undefined) || []);
}

function needsField(fields: string[], ...candidates: string[]): boolean {
  if (fields.length === 0) return true;
  return candidates.some(c => fields.includes(c));
}

// Collect page info fields only if requested by _field
async function collectPageInfo(fields: string[]): Promise<{ url?: string; title?: string; html?: string }> {
  const info: { url?: string; title?: string; html?: string } = {};
  const has = (name: string) => fields.length === 0 || fields.some(f => f === name || f === `currentTab.${name}`);
  if (has("url")) info.url = window.location.href;
  if (has("title")) info.title = document.title;
  if (has("html")) {
    // 默认包含 shadow DOM 内容：getHTML({shadowRoots:[...]}) 把 open shadow root
    // 以 <template shadowrootmode="open"> 内联进宿主元素；无 shadow 的页面输出与 outerHTML 一致。
    // 注意：getInnerHTML 从未正式发布，getHTML 的 includeShadowRoots 参数也被忽略，
    // 必须用 shadowRoots 数组显式列出（Chrome 145+，旧版退化为 outerHTML）
    const docEl = document.documentElement as HTMLElement & {
      getHTML?: (opts: { shadowRoots: ShadowRoot[] }) => string;
    };
    info.html = typeof docEl.getHTML === "function"
      ? docEl.getHTML({ shadowRoots: openShadowRootsDeep(document) })
      : document.documentElement.outerHTML;
  }
  return info;
}

// Collect iframe info only if requested by _field
async function collectIframes(fields: string[]): Promise<{ index: number; src: string; sameOrigin: boolean; url?: string; html?: string }[]> {
  if (fields.length > 0 && !fields.includes("iframes")) return [];
  const iframes: { index: number; src: string; sameOrigin: boolean; url?: string; html?: string }[] = [];
  document.querySelectorAll("iframe").forEach((f, i) => {
    const iframe = f as HTMLIFrameElement;
    let sameOrigin = false;
    let url: string | undefined;
    let html: string | undefined;
    try {
      const doc = iframe.contentDocument;
      if (doc) {
        sameOrigin = true;
        url = doc.location.href;
        html = doc.documentElement.outerHTML;
      }
    } catch {
      sameOrigin = false;
    }
    iframes.push({ index: i, src: iframe.src, sameOrigin, ...(sameOrigin ? { url, html } : {}) });
  });
  return iframes;
}

async function handleCommand(
  payload: { command: string; params?: Record<string, unknown> },
): Promise<{ success: boolean; data?: unknown; error?: string; notFound?: boolean }> {
  const { command, params = {} } = payload;
  const fields = getFieldFilter(params);

  try {
    switch (command) {
      case "click": {
        const known = ["text", "selector", "x", "y", "frame", "waitFor"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown click parameter(s): ${unknown.join(", ")} (expected text, selector, x, y, waitFor)` };
        }
        if (params.x !== undefined && typeof params.x !== "number") {
          return { success: false, error: `"x" must be a number (got ${JSON.stringify(params.x)})` };
        }
        if (params.y !== undefined && typeof params.y !== "number") {
          return { success: false, error: `"y" must be a number (got ${JSON.stringify(params.y)})` };
        }
        let el: Element;
        let clickDesc: Record<string, unknown> = {};

        // 真实用户点击的事件顺序是 pointerdown → mousedown → pointerup → mouseup → click：
        // 按完整序列派发（此前只有 3 个 MouseEvent——监听 pointer 事件的站点收不到点击；
        // 合成事件 isTrusted=false 无法伪装，需要 trusted 点击请用 real_click）。
        // composed:true 让事件穿透 shadow 边界——否则 shadow 内元素的 click 到不了外层
        // 事件代理（「穿透返回 ok 但不触发」的来源之一）。
        // text/selector 定位时先 scrollIntoView（真实点击前也会先滚动到目标）。
        // 返回派发坐标（rect 中心），供可点性探测使用。
        const dispatchFullClick = (target: Element, x?: number, y?: number): { cx: number; cy: number } => {
          if (x === undefined || y === undefined) {
            (target as HTMLElement).scrollIntoView({ block: "center" });
          }
          const rect = (target as HTMLElement).getBoundingClientRect();
          const cx = x ?? rect.left + rect.width / 2;
          const cy = y ?? rect.top + rect.height / 2;
          const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
          target.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
          target.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
          target.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
          target.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
          target.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
          return { cx, cy };
        };

        // 可点性报告：合成事件直接派发给目标、不经 hit-test；真实点击命中的是坐标处
        // 最上层元素。目标被盖住 / 在视口外时站点可能收不到点击——不静默，如实报告
        // （visible 恒有值；coveredBy / offscreen 只在有问题时出现）。
        // 只报告不拦截：照常派发（不因新规则破坏被覆盖元素的合法流程），
        // 由调用方根据报告决定是否改用 real_click。
        const coverageReport = (target: Element, cx: number, cy: number): Record<string, unknown> => {
          const htmlEl = target as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          if (!isVisible(htmlEl) || rect.width === 0 || rect.height === 0) {
            return { visible: false };
          }
          const top = document.elementFromPoint(cx, cy);
          if (!top) return { visible: true, offscreen: true };
          if (top !== target && !target.contains(top)) {
            return { visible: true, coveredBy: describeLayer(top) };
          }
          return { visible: true };
        };

        // 报告覆盖层 / 顶部命中元素的可读描述（tag + 类 + 前 200 字符文本，够定位即可）
        const describeLayer = (top: Element): Record<string, unknown> => {
          const htmlTop = top as HTMLElement;
          const desc: Record<string, unknown> = { tag: top.tagName.toLowerCase() };
          const cls = Array.from(htmlTop.classList).slice(0, 3).join(".");
          if (cls) desc.class = cls;
          // 覆盖层文字原样带出（不 trim 不截断）：报告也是文字——调用方拿去跟页面比对必须一致
          const txt = htmlTop.textContent || "";
          if (txt) desc.text = txt;
          return desc;
        };

        if (params.text) {
          const text = params.text as string;
          const found = findByText(text);
          if (!found) return { success: false, notFound: true, error: `No element found with text: ${text}` };
          el = found;
          const { cx, cy } = dispatchFullClick(el);
          clickDesc = { text, tag: (el as HTMLElement).tagName.toLowerCase(), ...coverageReport(el, cx, cy) };
        } else if (params.x !== undefined && params.y !== undefined) {
          const x = params.x as number;
          const y = params.y as number;
          const found = document.elementFromPoint(x, y);
          if (!found) return { success: false, notFound: true, error: `No element at (${x}, ${y})` };
          el = found;
          dispatchFullClick(el, x, y);
          clickDesc = { x, y, tag: (el as HTMLElement).tagName.toLowerCase() };
        } else {
          const selector = params.selector as string;
          if (!selector) return { success: false, error: "Need text, selector, or {x,y}" };
          const found = findElement(selector);
          if (!found) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          el = found;
          const { cx, cy } = dispatchFullClick(el);
          clickDesc = { selector, tag: (el as HTMLElement).tagName.toLowerCase(), ...coverageReport(el, cx, cy) };
        }

        let navigated = false;
        const onBeforeUnload = () => { navigated = true; };
        window.addEventListener("beforeunload", onBeforeUnload, { once: true });
        // 等影响落地：事件驱动的稳定检测（DOM/长任务/渲染 flush），导航发生时提前收尾
        const stable = await waitForSettled(3000);
        window.removeEventListener("beforeunload", onBeforeUnload);
        const waitForResult = params.waitFor
          ? await waitForCondition(params.waitFor as { selector?: string; text?: string }, 3000)
          : null;

        // Build response based on _field
        const data: Record<string, unknown> = { clickDesc, settledMs: stable.waited };
        if (waitForResult) data.waitFor = waitForResult;
        if (fields.length === 0 || needsField(fields, "navigated")) data.navigated = navigated;
        if (fields.length === 0 || needsField(fields, "current")) {
          const pageInfo = await collectPageInfo(fields);
          data.current = pageInfo;
        }
        // iframeChanged/iframeChanges 由 service worker 做前后快照对比（CS 无权对比），此处不输出
        return { success: true, data };
      }

      case "get_prop": {
        // 只读查询元素属性（innerHTML/value/checked/…）。返回的是元素的真实属性值：
        // 字符串/数字/布尔直接透传，对象只收 JSON 无损的普通数据（保真性由
        // nonJsonableReason 保证——不能把丢数据的东西悄悄发回去）
        const known = ["selector", "text", "prop", "frame"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown get_prop parameter(s): ${unknown.join(", ")} (expected selector, text, prop, frame)` };
        }
        const prop = params.prop;
        if (typeof prop !== "string" || !prop) {
          return { success: false, error: 'Need "prop" parameter (e.g. "innerHTML", "value", "checked")' };
        }
        for (const k of ["selector", "text"] as const) {
          const v = params[k];
          if (v !== undefined && typeof v !== "string") {
            return { success: false, error: `"${k}" must be a string (got ${JSON.stringify(v)})` };
          }
        }
        if (params.selector === undefined && params.text === undefined) {
          return { success: false, error: 'Need "selector" or "text" parameter' };
        }
        // text 优先（与 get_rect 一致）：两者都给时按文本定位
        const el = (params.text ? findByText(params.text as string) : findElement(params.selector as string)) as Element | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${(params.text ?? params.selector) as string}` };
        const tag = el.tagName.toLowerCase();
        if (!(prop in el)) {
          return {
            success: false,
            error: `No property "${prop}" on <${tag}> — examples: "innerHTML", "textContent", "value", "className", "checked", "id", "src", "href", "dataset"`,
          };
        }
        const val = (el as unknown as Record<string, unknown>)[prop];
        if (typeof val === "function") {
          return { success: false, error: `"${prop}" is a method on <${tag}> — get_prop only reads properties, it never calls methods` };
        }
        if (val === undefined) {
          return { success: false, error: `Property "${prop}" on <${tag}> is undefined (element found, but the property has no value)` };
        }
        if (val !== null && typeof val === "object") {
          const problem = nonJsonableReason(val);
          if (problem) {
            return { success: false, error: `Property "${prop}" on <${tag}> ${problem}` };
          }
        }
        return { success: true, data: val };
      }

      case "get_rect": {
        // 获取元素在视口中的坐标（供 real_click 真实点击使用）。
        // iframe 内元素的 getBoundingClientRect 相对 iframe 自身视口，
        // 沿 window.parent 链累加每层 frameElement 的偏移换算为顶层视口坐标；
        // 跨域边界无法读父 frame（getBoundingClientRect 抛 SecurityError）→ 标记 crossOrigin，
        // 返回 iframe 本地坐标，由 service worker 走 CDP getContentQuads 精确定位。
        const selector = params.selector as string;
        if (!selector && !params.text) return { success: false, error: 'Need "selector" or "text" parameter' };
        const el = (params.text ? findByText(params.text as string) : findElement(selector)) as HTMLElement | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${params.text || selector}` };
        // scroll:true（real_click 专用）：先滚进视口再测坐标——real_click 按坐标派发
        // CDP 真实鼠标事件，目标在视口外时坐标落在页面外，点击会静默落空。
        // 强制 behavior:"instant"：页面 CSS scroll-behavior:smooth 会让滚动异步进行，
        // 立即测量仍拿到动画前的旧坐标。
        if (params.scroll === true) {
          el.scrollIntoView({ block: "center", behavior: "instant" });
        }
        const rect = el.getBoundingClientRect();
        const lx = rect.left + rect.width / 2;
        const ly = rect.top + rect.height / 2;
        let x = lx;
        let y = ly;
        let crossOrigin = false;
        let win: Window = window;
        while (win.frameElement) {
          try {
            const fr = (win.frameElement as HTMLElement).getBoundingClientRect();
            x += fr.left;
            y += fr.top;
          } catch {
            crossOrigin = true;
            break;
          }
          win = win.parent;
        }
        return {
          success: true,
          data: {
            selector,
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            ...(crossOrigin ? { crossOrigin: true, localX: Math.round(lx), localY: Math.round(ly) } : {}),
          },
        };
      }

      case "show": {
        // 强制显示隐藏元素（仅改 CSS 样式，不执行代码）。
        // 作用于所有匹配元素：把 hover 才显示的工具条/菜单常驻可见，
        // inline style 优先级最高，不会被 hover CSS 覆盖，随后可被 click 命中。
        // 记录原样式值，hide 可精确还原。查找穿透 open shadow root（与 findElement 同语义）。
        const known = ["selector", "frame"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown show parameter(s): ${unknown.join(", ")} (expected selector)` };
        }
        const selector = params.selector as string;
        if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
        const els = findAllPierced(selector) as HTMLElement[];
        if (els.length === 0) return { success: false, notFound: true, error: `Element not found: ${selector}` };
        for (const el of els) {
          if (!showRegistry.has(el)) {
            showRegistry.set(el, {
              visibility: el.style.visibility || undefined,
              opacity: el.style.opacity || undefined,
              display: el.style.display || undefined,
            });
          }
          el.style.visibility = "visible";
          el.style.opacity = "1";
          if (el.style.display === "none" || getComputedStyle(el).display === "none") {
            el.style.display = "block";
          }
        }
        return { success: true, data: { selector, count: els.length } };
      }

      case "hide": {
        // 还原所有被 show 的元素：清掉 inline style，回到 CSS 控制
        const known: string[] = [];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown hide parameter(s): ${unknown.join(", ")} (hide takes no parameters)` };
        }
        const els = Array.from(showRegistry.keys());
        let count = 0;
        for (const el of els) {
          if (el.isConnected) {
            restoreShownElement(el);
            count++;
          }
        }
        return { success: true, data: { count } };
      }

      case "type": {
        const known = ["selector", "text", "mode", "frame", "waitFor"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown type parameter(s): ${unknown.join(", ")} (expected selector, text, mode, waitFor)` };
        }
        const selector = params.selector as string;
        const text = params.text as string;
        const mode = (params.mode as string) || "replace";
        if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
        if (typeof text !== "string") return { success: false, error: 'Need "text" parameter (a string)' };
        if (mode !== "replace" && mode !== "append" && mode !== "insert") {
          return { success: false, error: `Invalid mode: ${mode} (expected replace|append|insert)` };
        }
        const el = findElement(selector) as HTMLElement | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
        // input/textarea: 直接设置 value（mode 控制写入位置）
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (mode === "replace") {
            el.value = text;
          } else {
            el.focus();
            if (mode === "append") {
              // 追加到末尾
              const end = el.value.length;
              el.value = el.value.slice(0, end) + text;
              el.setSelectionRange(end + text.length, end + text.length);
            } else {
              // insert: 光标处插入，有选中则替换选区
              const start = el.selectionStart ?? 0;
              const end = el.selectionEnd ?? start;
              el.value = el.value.slice(0, start) + text + el.value.slice(end);
              const pos = start + text.length;
              el.setSelectionRange(pos, pos);
            }
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (!el.isContentEditable) {
          return { success: false, error: `Element not typeable: ${selector} (tag=${el.tagName}, contentEditable=${el.contentEditable})` };
        }
        // contenteditable (富文本编辑器如 ProseMirror): 聚焦后用 execCommand 模拟真实输入
        if (el.isContentEditable) {
          el.focus();
          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            if (mode === "replace") {
              // 清空原内容，从头写入
              range.selectNodeContents(el);
              sel.removeAllRanges();
              sel.addRange(range);
              document.execCommand("delete", false);
            } else if (mode === "append") {
              // 光标移到末尾
              range.selectNodeContents(el);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            } else {
              // insert: 保留现有选区；光标不在元素内则回退到末尾
              const anchor = sel.anchorNode;
              if (!(anchor instanceof Node) || !el.contains(anchor)) {
                range.selectNodeContents(el);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }
          }
          // 整段原样插入，零加工：insertText 是浏览器原生编辑命令（与真实输入/粘贴同一编辑管线），
          // 文本含 \n 时如何分行/分段由页面自己的原生行为决定，cda 不做任何拆分、裁剪或归一
          document.execCommand("insertText", false, text);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        // 等影响落地：事件驱动的稳定检测（编辑器 debounce 重排等）+ 可选 wait_for 谓词
        const stable = await waitForSettled(3000);
        const waitForResult = params.waitFor
          ? await waitForCondition(params.waitFor as { selector?: string; text?: string }, 3000)
          : null;
        const typeData: Record<string, unknown> = { selector, mode, tag: el.tagName.toLowerCase(), settledMs: stable.waited };
        if (waitForResult) typeData.waitFor = waitForResult;
        return { success: true, data: typeData };
      }

      case "keyboard": {
        // 向元素发送按键（合成 KeyboardEvent，keydown/keypress/keyup 完整链）。
        // selector 可省略：缺省用当前聚焦元素（document.activeElement）。
        // 参考 chrome_agent 的 keypress 实现：合成事件能触发页面 JS 的 keydown/keyup 处理器，
        // 但不会触发浏览器原生默认行为（如 input 内 Enter 换行/表单提交、Tab 切换焦点）。
        const known = ["selector", "key", "ctrl", "shift", "alt", "meta", "frame", "waitFor"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown keyboard parameter(s): ${unknown.join(", ")} (expected selector, key, ctrl, shift, alt, meta, waitFor)` };
        }
        for (const mod of ["ctrl", "shift", "alt", "meta"] as const) {
          const v = params[mod];
          if (v !== undefined && typeof v !== "boolean") {
            return { success: false, error: `"${mod}" must be true or false (got ${JSON.stringify(v)})` };
          }
        }
        const key = params.key as string | undefined;
        if (typeof key !== "string" || !key) return { success: false, error: 'Need "key" parameter (a string, e.g. Enter, Escape, Tab, ArrowDown, "a")' };
        const selector = params.selector as string | undefined;
        let el: Element | null = null;
        if (selector) {
          el = findElement(selector);
          if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
        } else {
          el = (document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
        }
        const target = el as HTMLElement;
        try { target.focus({ preventScroll: true }); } catch { /* 非聚焦元素 focus 是 no-op */ }
        const mods = {
          ctrlKey: !!params.ctrl,
          shiftKey: !!params.shift,
          altKey: !!params.alt,
          metaKey: !!params.meta,
        };
        const init = keyboardEventInit(key, mods);
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        // keypress 只对非修饰键派发（真实浏览器里 Control/Shift/Alt/Meta 不产生 keypress）
        if (!MODIFIER_KEYS.has(key)) target.dispatchEvent(new KeyboardEvent("keypress", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        // 等影响落地：按键触发的处理器/防抖渲染完成后再返回
        const stable = await waitForSettled(3000);
        const waitForResult = params.waitFor
          ? await waitForCondition(params.waitFor as { selector?: string; text?: string }, 3000)
          : null;
        const keyData: Record<string, unknown> = {
          key,
          ...(selector ? { selector } : {}),
          tag: target.tagName.toLowerCase(),
          modifiers: mods,
          settledMs: stable.waited,
        };
        if (waitForResult) keyData.waitFor = waitForResult;
        return { success: true, data: keyData };
      }

      case "upload_file": {
        const known = ["selector", "base64", "filename", "mime", "frame", "waitFor"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown upload_file parameter(s): ${unknown.join(", ")} (expected selector, base64, filename, mime, waitFor)` };
        }
        const selector = params.selector as string;
        const base64 = params.base64 as string;
        // filename/mime 必填：静默默认 "upload.png"/"image/png" 会把非图片内容贴错类型，
        // 被服务端静默拒收时调用方无从得知
        const filename = params.filename as string | undefined;
        const mime = params.mime as string | undefined;
        if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
        if (typeof base64 !== "string" || !base64) return { success: false, error: 'Need "base64" parameter (a string)' };
        if (typeof filename !== "string" || !filename) return { success: false, error: 'Need "filename" parameter (e.g. "a.jpg")' };
        if (typeof mime !== "string" || !mime) return { success: false, error: 'Need "mime" parameter (e.g. "image/jpeg")' };
        const el = findElement(selector) as HTMLInputElement | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
        if (!(el instanceof HTMLInputElement) || el.type !== "file") {
          return { success: false, error: `Element is not a file input: ${selector}` };
        }
        // accept 预检：注入到 accept 不匹配的 input 会被页面静默忽略（注入成功但上传不触发，
        // 误导调用方以为成功）——客户端先拦下，避免抖音这类多 file input 页面注入错目标
        if (el.accept && !acceptMatches(el.accept, mime, filename)) {
          return { success: false, error: `File type not accepted by input: mime=${mime} filename=${filename}, accept="${el.accept}"` };
        }
        // base64 -> Uint8Array
        const clean = base64.replace(/^data:[^;]+;base64,/, "");
        const bin = atob(clean);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], filename, { type: mime });
        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        // 等影响落地：页面 change 处理器可能异步改 DOM（如预览图渲染）；
        // 上传完成进度不在 cda 控制范围，需要精确等待用 wait_for 谓词
        const stable = await waitForSettled(3000);
        const waitForResult = params.waitFor
          ? await waitForCondition(params.waitFor as { selector?: string; text?: string }, 3000)
          : null;
        const uploadData: Record<string, unknown> = {
          selector,
          tag: el.tagName.toLowerCase(),
          filename,
          size: bytes.length,
          mime,
          settledMs: stable.waited,
        };
        if (waitForResult) uploadData.waitFor = waitForResult;
        return { success: true, data: uploadData };
      }

      case "upload_dragdrop": {
        // 向没有 file input、只认 drop 事件的上传组件（AntD Upload.Dragger、自定义拖拽区等）
        // 拖入文件：构造带 File 的 DataTransfer，派发 dragenter → dragover → drop。
        // 与 upload_file 互补：有 input[type=file] 用 upload_file，只有 drop 区域用本命令。
        // 注意合成 drop 是页面内拖拽模拟（isTrusted=false）：能触发页面 JS 的 drop 处理器，
        // 但无法模拟从系统文件管理器拖入的真实拖拽（浏览器原生 DnD），校验 isTrusted 的站点无效。
        const selector = params.selector as string;
        const data = params.data as Record<string, unknown> | undefined;
        if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return { success: false, error: '"data" must be an object: {"base64":"...","filename":"a.jpg","mime":"image/jpeg"} or {"url":"https://..."}' };
        }
        const known = ["selector", "data", "waitFor", "frame"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown upload_dragdrop parameter(s): ${unknown.join(", ")} (expected selector, data, waitFor, frame)` };
        }
        const knownData = ["base64", "filename", "mime", "url"];
        const unknownData = Object.keys(data).filter((k) => !knownData.includes(k));
        if (unknownData.length) {
          return { success: false, error: `Unknown data field(s): ${unknownData.join(", ")} (expected base64, filename, mime, url)` };
        }
        if ((data.base64 !== undefined) === (data.url !== undefined)) {
          return { success: false, error: '"data" must have exactly one of "base64" or "url"' };
        }
        const el = findElement(selector) as HTMLElement | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };

        let file: File;
        if (data.base64 !== undefined) {
          const filename = data.filename as string | undefined;
          const mime = data.mime as string | undefined;
          if (typeof filename !== "string" || !filename) {
            return { success: false, error: '"data" needs "filename" (e.g. "a.jpg") when using base64 — no silent default file name' };
          }
          if (typeof mime !== "string" || !mime) {
            return { success: false, error: '"data" needs "mime" (e.g. "image/jpeg") when using base64 — no silent default type' };
          }
          try {
            file = base64ToFile(data.base64 as string, filename, mime);
          } catch {
            return { success: false, error: "Invalid base64 in data" };
          }
        } else {
          const url = data.url as string;
          try {
            const resp = await fetch(url);
            if (!resp.ok) {
              return { success: false, error: `Failed to fetch url: ${url} (HTTP ${resp.status})` };
            }
            const blob = await resp.blob();
            // 文件名派生自 URL 时去掉 query/hash（"a.jpg?token=1" 的尾巴会混进文件名）
            const derived = url.split(/[?#]/)[0].split("/").pop() || "";
            const name = (data.filename as string) || derived;
            if (!name) {
              return { success: false, error: 'Could not derive a file name from the URL path (e.g. redirect targets) — pass "data.filename" explicitly' };
            }
            file = new File([blob], name, { type: blob.type || "application/octet-stream" });
          } catch (e) {
            return { success: false, error: `Failed to fetch url: ${url} (${(e as Error).message})` };
          }
        }

        const dt = new DataTransfer();
        dt.items.add(file);
        for (const type of ["dragenter", "dragover", "drop"] as const) {
          el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        }
        // 等影响落地：drop 处理器可能异步渲染预览 / 发起上传，落地后再返回
        const stable = await waitForSettled(3000);
        const waitForResult = params.waitFor
          ? await waitForCondition(params.waitFor as { selector?: string; text?: string }, 3000)
          : null;
        const dropData: Record<string, unknown> = {
          selector,
          tag: el.tagName.toLowerCase(),
          filename: file.name,
          size: file.size,
          mime: file.type,
          settledMs: stable.waited,
        };
        if (waitForResult) dropData.waitFor = waitForResult;
        return { success: true, data: dropData };
      }

      case "paste_rich": {
        // 向 contenteditable 粘贴带样式的 HTML（{selector,html[,mode][,waitFor]}）：
        //   mode replace（默认，先清空原内容）/ append（追加到末尾）/ insert（光标处插入）
        // 只操作浏览器原生编辑命令（置光标 + execCommand insertHTML/delete）——与真实粘贴走同一
        // 编辑管线。HTML 怎么解析、分段、清空语义怎么落地，是页面编辑器自己的原生行为；
        // cda 不做任何编辑器嗅探/适配/清洗，怎么适应是调用方 agent 的事。
        const known = ["selector", "html", "mode", "frame", "waitFor"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown paste_rich parameter(s): ${unknown.join(", ")} (expected selector, html, mode, waitFor)` };
        }
        const selector = params.selector as string;
        const html = params.html as string;
        const mode = (params.mode as string) || "replace";
        if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
        if (typeof html !== "string" || !html) return { success: false, error: 'Need "html" parameter (a string)' };
        if (mode !== "replace" && mode !== "append" && mode !== "insert") {
          return { success: false, error: `Invalid mode: ${mode} (expected replace|append|insert)` };
        }
        const el = findElement(selector) as HTMLElement | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
        if (!el.isContentEditable) {
          return { success: false, error: `Element is not contenteditable: ${selector} (tag=${el.tagName})` };
        }
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          if (mode === "replace") {
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand("delete", false);
          } else if (mode === "append") {
            range.selectNodeContents(el);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          } else {
            // insert：保留现有选区；光标不在元素内则移到末尾
            const anchor = sel.anchorNode;
            if (!(anchor instanceof Node) || !el.contains(anchor)) {
              range.selectNodeContents(el);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        }
        // 整段原样插入：insertHTML 是浏览器原生编辑命令，样式如何落地由编辑器自己的原生行为决定
        document.execCommand("insertHTML", false, html);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        // 等影响落地：编辑器收到内容后的重排/防抖渲染完成再返回
        const stable = await waitForSettled(3000);
        const waitForResult = params.waitFor
          ? await waitForCondition(params.waitFor as { selector?: string; text?: string }, 3000)
          : null;
        const pasteData: Record<string, unknown> = {
          selector,
          mode,
          tag: el.tagName.toLowerCase(),
          inserted: true,
          settledMs: stable.waited,
        };
        if (waitForResult) pasteData.waitFor = waitForResult;
        return { success: true, data: pasteData };
      }

      case "trigger": {
        // 触发元素的事件（blur/change/input/focus/select/自定义事件等），常用于：
        //   - blur：表单校验（Element UI / Ant Design 等在 blur 上触发校验）
        //   - change + value：选择下拉框选项 / 更新 input 值后派发 change
        //   - 自定义事件：框架驱动的站点监听自定义事件时
        // 可选 {value} 先设属性再派发：select 选项 / input 值 / checkbox 勾选。
        //   React 受控组件同样生效——走原型链原生 setter 绕过 React 的 value tracker，
        //   否则受控组件比对 tracker 认为"值没变"而不更新 state。
        // 可选 {options} 透传给事件构造器（bubbles/cancelable/composed/detail 等）。
        // focus/blur 优先走真实方法（activeElement 真的转移、:focus 样式生效）；
        // 目标不在焦点上时真实方法是 no-op，退化为合成事件，保证处理器必然触发。
        // 注意合成事件 isTrusted=false，与 click 同类；对校验 isTrusted 的站点无效
        // （此类站点对任意事件都无效，需 real_click 级别的真实事件）。
        const selector = params.selector as string;
        const event = params.event as string;
        if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
        if (typeof event !== "string" || !event) {
          return { success: false, error: 'Need "event" parameter (a string, e.g. "change", "blur", "focus", "input", "select", or a custom event name)' };
        }
        const known = ["selector", "event", "value", "options", "frame", "waitFor"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown trigger parameter(s): ${unknown.join(", ")} (expected selector, event, value, options)` };
        }
        const el = findElement(selector) as HTMLElement | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };

        let valueApplied = false;
        if (params.value !== undefined) {
          if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
            let checked: boolean;
            if (typeof params.value === "boolean") {
              checked = params.value;
            } else if (params.value === "true" || params.value === "false") {
              checked = params.value === "true";
            } else {
              return { success: false, error: `Invalid value for ${el.type}: ${params.value} (expected true/false)` };
            }
            setNativeChecked(el, checked);
            valueApplied = true;
          } else if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            if (typeof params.value !== "string" && typeof params.value !== "number" && typeof params.value !== "boolean") {
              return { success: false, error: `Invalid value: ${JSON.stringify(params.value)} (expected string or number)` };
            }
            setNativeValue(el, params.value);
            valueApplied = true;
          } else {
            return { success: false, error: `"value" only applies to input/textarea/select (got ${el.tagName.toLowerCase()})` };
          }
        }

        let options: Record<string, unknown> = {};
        if (params.options !== undefined) {
          if (typeof params.options !== "object" || params.options === null || Array.isArray(params.options)) {
            return { success: false, error: '"options" must be an object (EventInit properties, e.g. {"detail": {...}, "cancelable": false})' };
          }
          options = params.options as Record<string, unknown>;
        }
        const init = { bubbles: true, cancelable: true, composed: true, ...options };

        // focus/blur：真实方法优先（activeElement 转移、:focus 样式、React onFocus/onBlur 都正确）；
        // 目标不在焦点上时真实方法是 no-op → 退化为合成事件，确保处理器至少触发一次
        if (event === "focus") {
          if (document.activeElement !== el) el.focus();
          else el.dispatchEvent(new Event("focus", init));
        } else if (event === "blur") {
          if (document.activeElement === el) el.blur();
          else el.dispatchEvent(new Event("blur", init));
        } else {
          el.dispatchEvent(constructTriggerEvent(event, init));
        }

        // 等影响落地：事件处理器可能异步改 DOM（校验提示、联动重排等），落地后再返回
        const stable = await waitForSettled(3000);
        const waitForResult = params.waitFor
          ? await waitForCondition(params.waitFor as { selector?: string; text?: string }, 3000)
          : null;
        const triggerData: Record<string, unknown> = {
          selector,
          event,
          tag: el.tagName.toLowerCase(),
          ...(valueApplied ? { value: params.value } : {}),
          settledMs: stable.waited,
        };
        if (waitForResult) triggerData.waitFor = waitForResult;
        return { success: true, data: triggerData };
      }

      case "get_text": {
        const known = ["selector", "frame"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown get_text parameter(s): ${unknown.join(", ")} (expected selector)` };
        }
        const selector = params.selector as string;
        if (selector !== undefined && typeof selector !== "string") {
          return { success: false, error: `"selector" must be a string (got ${JSON.stringify(selector)})` };
        }
        const el = selector ? findElement(selector) : document.body;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
        // 原样返回 textContent：不 trim、不折叠空白——读取与写入同样零加工
        return { success: true, data: el.textContent ?? "" };
      }

      case "get_css": {
        const known = ["selector", "frame"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown get_css parameter(s): ${unknown.join(", ")} (expected selector)` };
        }
        const selector = params.selector as string;
        if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
        const isCss = selector.startsWith("css:");
        const query = isCss ? selector.slice(4) : selector;
        // css: 前缀命中全部匹配；其余走 findElement（两者都穿透 open shadow root）
        const nodes = isCss ? findAllPierced(query) : [findElement(selector)].filter(Boolean) as Element[];
        if (nodes.length === 0) return { success: false, notFound: true, error: `Element not found: ${selector}` };
        const results = Array.from(nodes).map((el, i) => {
          const computed = window.getComputedStyle(el);
          const css: Record<string, string> = {};
          for (let j = 0; j < computed.length; j++) {
            const prop = computed[j];
            css[prop] = computed.getPropertyValue(prop);
          }
          return { index: i, css };
        });
        return { success: true, data: { selector, count: nodes.length, results } };
      }

      case "frame_info": {
        // 返回自身 frame 的文档信息（供 service worker 补全跨域 iframe 元数据）
        return {
          success: true,
          data: {
            url: window.location.href,
            title: document.title,
            html: document.documentElement.outerHTML,
          },
        };
      }

      case "get_page_info": {
        const [pageInfo, iframes] = await Promise.all([
          collectPageInfo(fields),
          collectIframes(fields),
        ]);
        const data: Record<string, unknown> = { ...pageInfo };
        if (fields.length === 0 || fields.includes("iframes")) data.iframes = iframes;
        return { success: true, data };
      }

      case "list_elements": {
        // 扫描当前 frame 的可交互元素（穿透 open shadow root），生成带 selector 的清单，
        // 供 agent 先查后操作；service worker 按 frame 汇总各 frame 的结果
        const known = ["frame", "filter", "text", "max", "visible"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown list_elements parameter(s): ${unknown.join(", ")} (expected frame, filter, text, max, visible)` };
        }
        if (params.filter !== undefined && typeof params.filter !== "string") {
          return { success: false, error: '"filter" must be a comma-separated string (button|link|input|select|textarea|label|editable|upload)' };
        }
        if (params.text !== undefined && typeof params.text !== "string") {
          return { success: false, error: '"text" must be a string (substring match on element text)' };
        }
        if (params.visible !== undefined && typeof params.visible !== "boolean") {
          return { success: false, error: '"visible" must be true (visible only) or false (hidden only)' };
        }
        if (params.max !== undefined && (typeof params.max !== "number" || !Number.isFinite(params.max))) {
          return { success: false, error: '"max" must be a number (1-200)' };
        }
        const VALID_FILTERS = new Set(["button", "link", "input", "select", "textarea", "label", "editable", "upload"]);
        const filters = params.filter
          ? params.filter.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
          : [];
        // 未知 filter token（拼错/不支持）直接报错：静默当"全不过滤"会返回一堆无关元素
        for (const f of filters) {
          if (!VALID_FILTERS.has(f)) {
            return { success: false, error: `Unknown list_elements filter: "${f}" (expected button|link|input|select|textarea|label|editable|upload)` };
          }
        }
        // text 参数零加工：按原样做子串匹配（不做 trim——给什么匹配什么）
        const textFilter = typeof params.text === "string" ? params.text : "";
        let max = typeof params.max === "number" && Number.isFinite(params.max) ? Math.max(1, Math.floor(params.max)) : 50;
        max = Math.min(max, 200);
        const visibleOnly = params.visible === true;
        const hiddenOnly = params.visible === false;

        // 候选范围：light DOM + 所有 open shadow root（按文档序去重）
        const INTERACTIVE_SELECTOR = "button, a, select, textarea, input, label, [contenteditable], [tabindex], [role]";
        const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "combobox", "textbox", "listbox", "slider", "spinbutton", "searchbox"]);
        const candidates: Element[] = [];
        const seen = new Set<Element>();
        const consider = (el: Element) => {
          if (seen.has(el) || el instanceof HTMLScriptElement || el instanceof HTMLStyleElement || el instanceof HTMLTemplateElement) return;
          const role = el.getAttribute("role")?.toLowerCase();
          if (role && !INTERACTIVE_ROLES.has(role)) return;
          seen.add(el);
          candidates.push(el);
        };
        for (const el of Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))) consider(el);
        for (const sr of openShadowRootsDeep(document)) {
          for (const el of Array.from(sr.querySelectorAll(INTERACTIVE_SELECTOR))) consider(el);
        }

        const elements: ElementInfo[] = [];
        for (const el of candidates) {
          const html = el as HTMLElement;
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role")?.toLowerCase() ?? undefined;
          const type = el instanceof HTMLInputElement ? el.type : undefined;
          // 空白折叠与 click {text} 的按文本查找一致（XPath normalize-space 同样折叠）——
          // 但绝不截断：截到 80 字符会让"按 list_elements 的 text 回点"匹配不上真实文本
          const text = (html.innerText ?? "").trim().replace(/\s+/g, " ");
          const visible = isVisible(html);
          if (visibleOnly && !visible) continue;
          if (hiddenOnly && visible) continue;
          if (textFilter && !text.includes(textFilter)) continue;
          if (filters.length > 0) {
            const hit = filters.some((f) => {
              switch (f) {
                case "button": return tag === "button" || role === "button";
                case "link": return tag === "a" || role === "link";
                case "input": return tag === "input";
                case "select": return tag === "select";
                case "textarea": return tag === "textarea";
                case "label": return tag === "label";
                case "editable": return html.isContentEditable || tag === "textarea" || (tag === "input" && type !== undefined && /text|search|email|url|tel|number|password|date|time|datetime-local|month|week/.test(type));
                case "upload": return (tag === "input" && type === "file") || /点击上传|上传|拖入|拖拽|拖到|upload|drop/i.test(text);
                default: return true;
              }
            });
            if (!hit) continue;
          }
          const rect = el.getBoundingClientRect();
          const item: ElementInfo = {
            tag,
            visible,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            selector: genSelector(el),
          };
          if (el instanceof HTMLInputElement) {
            if (type) item.type = type;
            if (el.accept) item.accept = el.accept;
            if (el.multiple) item.multiple = true;
            if (el.name) item.name = el.name;
            if (el.placeholder) item.placeholder = el.placeholder;
          }
          if (role) item.role = role;
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) item.ariaLabel = ariaLabel;
          const title = el.getAttribute("title");
          if (title) item.title = title;
          if (text) item.text = text;
          elements.push(item);
        }

        const truncated = elements.length > max;
        return {
          success: true,
          data: { count: truncated ? max : elements.length, truncated, elements: truncated ? elements.slice(0, max) : elements },
        };
      }

      case "get_js_errors": {
        const all = [...jsErrors];
        return { success: true, data: { errors: all, count: all.length } };
      }

      case "clear_js_errors": {
        jsErrors.length = 0;
        return { success: true };
      }

      case "wait_for_page": {
        const timeout = (params.timeout as number) ?? 10000;
        const start = Date.now();
        return new Promise<{ success: boolean; data: { readyState: string; elapsed: number } }>((resolve) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const cleanup = () => {
            document.removeEventListener("readystatechange", onChange);
            if (timer != null) clearTimeout(timer);
          };
          const onChange = () => {
            if (document.readyState === "complete") {
              settled = true;
              cleanup();
              waitForSettled(3000).then(() => {
                resolve({ success: true, data: { readyState: "complete", elapsed: Date.now() - start } });
              });
            }
          };
          document.addEventListener("readystatechange", onChange);
          if (document.readyState === "complete") {
            settled = true;
            cleanup();
            waitForSettled(3000).then(() => {
              resolve({ success: true, data: { readyState: "complete", elapsed: Date.now() - start } });
            });
          } else {
            timer = setTimeout(() => {
              if (settled) return;
              cleanup();
              resolve({ success: true, data: { readyState: document.readyState, elapsed: Date.now() - start } });
            }, timeout);
          }
        });
      }

      case "scroll": {
        // 滚动作用域由调用方选定（SW 按 frame 参数分发到目标 frame，缺省顶层）。
        // {x,y}              滚窗口/iframe；{selector} 滚动到元素：
        //   - 元素是可滚动容器（scrollHeight/clientHeight 溢出）→ 容器内滚动到 {x,y}
        //   - 普通元素 → scrollIntoView 进入可视区（shadow 内元素同样生效）
        // 白名单校验：未知参数（如 direction）静默忽略会退化成滚回 (0,0) 并返回成功，误导调用方
        const known = ["x", "y", "selector", "block", "frame"];
        const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
        if (unknown.length) {
          return { success: false, error: `Unknown scroll parameter(s): ${unknown.join(", ")} (expected x, y, selector, block)` };
        }
        for (const c of ["x", "y"] as const) {
          const v = params[c];
          if (v !== undefined && typeof v !== "number") {
            return { success: false, error: `"${c}" must be a number (got ${JSON.stringify(v)})` };
          }
        }
        // block 非法值直接报错：拼错（如 "centr"）会静默回落 "center"，滚动位置与预期不符
        if (params.block !== undefined) {
          if (typeof params.block !== "string" || !["start", "center", "end", "nearest"].includes(params.block as string)) {
            return { success: false, error: `Invalid block: ${JSON.stringify(params.block)} (expected start|center|end|nearest)` };
          }
        }
        const x = (params.x as number) ?? 0;
        const y = (params.y as number) ?? 0;
        const selector = params.selector as string | undefined;
        if (selector) {
          const el = findElement(selector) as HTMLElement | null;
          if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
            el.scrollTo({ top: y, left: x, behavior: "smooth" });
            await waitForSettled(3000);
            return { success: true, data: { scrollTarget: "container", scrollX: el.scrollLeft, scrollY: el.scrollTop } };
          }
          const block = (["start", "center", "end", "nearest"] as string[]).includes(params.block as string)
            ? (params.block as ScrollLogicalPosition)
            : "center";
          el.scrollIntoView({ behavior: "smooth", block });
          await waitForSettled(3000);
          return { success: true, data: { scrollTarget: "element", scrolledIntoView: selector } };
        }
        window.scrollTo({ top: y, left: x, behavior: "smooth" });
        await waitForSettled(3000);
        return { success: true, data: { scrollX: window.scrollX, scrollY: window.scrollY } };
      }

      // 内部命令（SW real_click 点击后调用；CLI 不可直接发——BLOCKED）：等影响落地
      case "wait_for_settle": {
        const timeout = (params.timeout as number) ?? 3000;
        const stable = await waitForSettled(timeout);
        const waitForResult = params.wait_for
          ? await waitForCondition(params.wait_for as { selector?: string; text?: string }, timeout)
          : null;
        return {
          success: true,
          data: {
            settled: stable.waited < timeout,
            settledMs: stable.waited,
            ...(waitForResult ? { waitFor: waitForResult } : {}),
          },
        };
      }

      default:
        return { success: false, error: `Unknown command: ${command}` };
    }
  } catch (err) {
    // 兜底：任何命令内部意外异常都以可读形式带出（命令名 + 意外错误），
    // 原始细节留末尾供排查——不让调用方拿到孤零零的技术报错
    const detail = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Unexpected error while running "${command}": ${detail} (please report this to cda)` };
  }
}

// 节流安全计时器：hidden 页面（后台 tab）的 setTimeout 被 Chrome 节流
// （对齐到 ~1s；hidden 超 5 分钟更进一步节流到 1 次/分钟），静默判定/谓词轮询
// 会因此被拉长。hidden 时改用 MessageChannel 忙循环计时——postMessage 消息事件
// 不受 timer throttling 影响（短暂忙循环，后台页不渲染，可接受）；
// 可见页面走正常 setTimeout，零额外开销。返回 {promise, cancel}。
function throttleSafeTimer(ms: number): { promise: Promise<void>; cancel: () => void } {
  if (document.visibilityState !== "hidden") {
    let timer: number | undefined;
    const promise = new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, ms);
    });
    return {
      promise,
      cancel: () => { if (timer != null) clearTimeout(timer); },
    };
  }
  let cancelled = false;
  const start = performance.now();
  const ch = new MessageChannel();
  const promise = new Promise<void>((resolve) => {
    ch.port1.onmessage = () => {
      if (cancelled) return;
      if (performance.now() - start >= ms) {
        ch.port1.onmessage = null;
        ch.port1.close();
        ch.port2.close();
        resolve();
      } else {
        ch.port2.postMessage(0);
      }
    };
    ch.port2.postMessage(0);
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      ch.port1.onmessage = null;
      ch.port1.close();
      ch.port2.close();
    },
  };
}

// 动作后的稳定检测（事件驱动，非 sleep）。两阶段：
//   阶段 1「活动窗口」（600ms）：等待动作影响的第一波信号（DOM 变化/长任务）——
//     信号到达立即进入阶段 2；窗口耗尽仍无信号（动作无影响或影响超窗口）→ 放行。
//     窗口是「等第一个信号的观察期」，不是固定等待：影响 100ms 到就 100ms 推进。
//   阶段 2「静默判定」（250ms）：每次活动信号重启静默计时，真正安静 250ms
//     （事件处理/渲染/debounce 都落地）即放行。
// 信号源：① MutationObserver（childList/attributes/characterData，覆盖文字/属性修改）
//         ② PerformanceObserver longtask（主线程繁忙）
// 双 rAF 只作渲染 flush 锚点（动作后的第一帧），不视为活动信号。
// maxWaitMs 只是防挂死保险，不是推进机制。返回等待耗时（≈maxWaitMs 说明超时兜底）。
// 注意：纯网络等待（fetch 响应前无 DOM 活动）超出本检测的覆盖，用 wait_for 谓词等待。
function waitForSettled(maxWaitMs: number): Promise<{ waited: number }> {
  const QUIET_MS = 250;
  const ACTIVITY_WINDOW_MS = 600;
  const start = Date.now();
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof throttleSafeTimer> | undefined;
    let inQuiet = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      domObserver?.disconnect();
      longtaskObserver?.disconnect();
      quiet?.cancel();
      resolve({ waited: Date.now() - start });
    };
    const onActivity = () => {
      if (!inQuiet) {
        inQuiet = true; // 阶段 1 → 2：首个影响信号
        activity?.cancel();
        // 补挂动态新增的 open shadow root（其后续变化 light DOM 观察器看不到）
        for (const sr of openShadowRootsDeep(document)) {
          try { domObserver?.observe(sr, { childList: true, subtree: true, attributes: true, characterData: true }); } catch { /* 单个 root 失败忽略 */ }
        }
      }
      quiet?.cancel();
      quiet = throttleSafeTimer(QUIET_MS);
      quiet.promise.then(finish);
    };
    // 阶段 1 的观察窗口：无信号时在此放行（动作无影响 / 影响在窗口外）
    // 计时走 throttleSafeTimer：后台 tab 的 setTimeout 被节流会拉长窗口。
    // 后台 tab（hidden）额外问题：页面自身的 setTimeout 与 MutationObserver 回调
    // 也被 Chrome 节流（hidden 时 1s 唤醒对齐，5 分钟后更甚）——「影响落地」本身
    // 会被推迟、信号会迟到。窗口耗尽后追加一个节流周期确认期：影响被节流推迟到
    // ~1s 内落地时能等到；确认期结束仍无信号才放行（此时代价是慢 ~1s，换来正确）。
    // 深度后台（intensive throttling，节流到分钟级）等不到，用 wait_for 谓词等待。
    const activity = throttleSafeTimer(ACTIVITY_WINDOW_MS);
    activity.promise.then(() => {
      if (inQuiet) return;
      if (document.visibilityState !== "hidden") {
        finish();
        return;
      }
      const confirm = throttleSafeTimer(1000);
      confirm.promise.then(() => {
        if (!inQuiet) finish();
      });
    });
    let domObserver: MutationObserver | undefined;
    try {
      domObserver = new MutationObserver(() => onActivity());
      // MutationObserver 不穿透 shadow boundary：除 document.body 外，对当前所有
      // open shadow root 也挂观察（shadow tree 内的文字/属性/结构变化同样算活动信号）
      const observeRoot = (root: Node) => {
        try {
          domObserver?.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
        } catch { /* 单个 root 失败忽略 */ }
      };
      if (document.body) observeRoot(document.body);
      for (const sr of openShadowRootsDeep(document)) observeRoot(sr);
    } catch { /* body 不存在等极端情况：跳过 DOM 信号 */ }
    let longtaskObserver: PerformanceObserver | undefined;
    try {
      if (typeof PerformanceObserver !== "undefined") {
        longtaskObserver = new PerformanceObserver(() => onActivity());
        longtaskObserver.observe({ entryTypes: ["longtask"] });
      }
    } catch { /* 不支持 longtask 的浏览器：跳过 */ }
    // 双 rAF：动作后的渲染 flush 锚点（后台 tab 不触发 rAF 时由活动窗口兜底）
    requestAnimationFrame(() => requestAnimationFrame(() => { /* no-op */ }));
    setTimeout(finish, maxWaitMs);
  });
}

// wait_for 谓词等待：轮询检查条件（50ms 间隔），条件满足的瞬间立即返回（不是 sleep——
// 100ms 落地就 100ms 返回）；超时返回 settled:false（动作本身已成功，仅影响未确认）。
// waitFor 格式：{"selector": "..."} 找元素且可见（含 shadow 穿透）；{"text": "..."} 按可见文本找。
async function waitForCondition(
  waitFor: { selector?: string; text?: string },
  timeoutMs: number,
): Promise<{ settled: boolean; waited: number }> {
  // 谓词显式二选一且类型严格：两者都给 / 未知键 / 空对象都抛错——
  // 不再静默偏袒 text、不再忽略未知键（被忽略的条件永远不会被等待，静默假等待）
  const extra = Object.keys(waitFor).filter((k) => k !== "selector" && k !== "text");
  if (extra.length > 0) throw new Error(`Invalid waitFor key(s): ${extra.join(", ")} (expected "selector" or "text")`);
  if (waitFor.selector === undefined && waitFor.text === undefined) {
    throw new Error('waitFor: provide "selector" or "text"');
  }
  if (waitFor.selector !== undefined && waitFor.text !== undefined) {
    throw new Error('waitFor: provide "selector" or "text", not both');
  }
  if (waitFor.selector !== undefined && typeof waitFor.selector !== "string") {
    throw new Error("waitFor.selector must be a string");
  }
  if (waitFor.text !== undefined && typeof waitFor.text !== "string") {
    throw new Error("waitFor.text must be a string");
  }
  const start = Date.now();
  const check = () => {
    if (waitFor.text) return !!findByText(waitFor.text);
    const el = findElement(waitFor.selector as string) as HTMLElement | null;
    return !!el && isVisible(el);
  };
  if (check()) return { settled: true, waited: 0 };
  while (Date.now() - start < timeoutMs) {
    // throttleSafeTimer：后台 tab 的 setTimeout 被节流（~1s 对齐），轮询会因此失效
    await throttleSafeTimer(50).promise;
    if (check()) return { settled: true, waited: Date.now() - start };
  }
  return { settled: false, waited: timeoutMs };
}

// 在指定上下文内按文本 XPath 查找第一个可见元素（light DOM 与 shadow root 共用，
// shadow tree 内没有 body，用不带 //body// 前缀的变体）
function evalTextXPath(xpath: string, context: Document | ShadowRoot | Element): Element | null {
  // Chrome 的 document.evaluate 不接受 ShadowRoot（#document-fragment）作 context node，
  // 对 shadow tree 改按顶层子元素逐个求值（// 相对 context 节点展开，覆盖整棵子树；
  // 子元素是 Element，递归落入下方 evaluate 分支，Element 与 Document 同为合法 context）
  if (context instanceof ShadowRoot) {
    for (const child of Array.from(context.children)) {
      const hit = evalTextXPath(xpath, child);
      if (hit) return hit;
    }
    return null;
  }
  const result = document.evaluate(xpath, context, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
  let el = result.iterateNext();
  while (el) {
    const htmlEl = el as HTMLElement;
    if (isVisible(htmlEl)) return htmlEl;
    el = result.iterateNext();
  }
  return null;
}

function findByText(text: string): Element | null {
  const q = xpathStr(text);
  const hidden = "self::script or self::style or self::noscript or self::template or self::head or self::title or self::meta or self::svg or self::path";
  const bodyXpath = [
    `//body//button[contains(normalize-space(.), ${q})]`,
    `//body//a[contains(normalize-space(.), ${q})]`,
    `//body//input[contains(@value, ${q})]`,
    `//body//*[not(${hidden})][contains(normalize-space(.), ${q}) and not(./*[not(${hidden})][contains(normalize-space(.), ${q})])]`,
  ].join(" | ");
  const shadowXpath = bodyXpath.split("//body//").join("//");

  const hit = evalTextXPath(bodyXpath, document);
  if (hit) return hit;
  // light DOM 未命中 → 按文档序搜索所有 open shadow root（含嵌套）
  for (const sr of openShadowRootsDeep(document)) {
    const h = evalTextXPath(shadowXpath, sr);
    if (h) return h;
  }
  return null;
}

// get_prop 对象值保真检查：返回值要穿过 CS→SW→server→CLI 的 JSON 链路，途中丢数据
// （函数/undefined/循环引用/DOM node/CSSStyleDeclaration/DOMRect 之类非普通对象）就是
// 静默假结果。检查不通过返回可读的原因（null 表示无损）；只放行 JSON 无损的普通对象
function nonJsonableReason(val: unknown, seen = new Set<object>()): string | null {
  if (typeof val === "function") return "is a function — JSON cannot carry it";
  if (val === null || typeof val !== "object") return null;
  if (seen.has(val)) return "contains a circular reference — JSON cannot carry it";
  seen.add(val);
  if (Array.isArray(val)) {
    for (const item of val) {
      if (item === undefined) return "contains an undefined element — JSON cannot carry it";
      const reason = nonJsonableReason(item, seen);
      if (reason) return reason;
    }
    seen.delete(val);
    return null;
  }
  const proto = Object.getPrototypeOf(val);
  if (proto !== Object.prototype && proto !== null) {
    return `holds a ${(val as { constructor?: { name?: string } }).constructor?.name || "non-plain"} object — only plain data can be returned; read a string/number property like "innerHTML" or "value" instead`;
  }
  // 不可枚举自有属性（DOMRect 的 x/y 等访问器值）在 JSON 序列化中静默丢失 → 拒绝，不返回空对象
  if (Object.getOwnPropertyNames(val).length !== Object.keys(val).length) {
    return `holds a ${(val as { constructor?: { name?: string } }).constructor?.name || "non-plain"} object — only plain data can be returned; read a string/number property like "innerHTML" or "value" instead`;
  }
  for (const key of Object.keys(val as Record<string, unknown>)) {
    const item = (val as Record<string, unknown>)[key];
    if (item === undefined) return `contains an undefined value under "${key}" — JSON cannot carry it`;
    const reason = nonJsonableReason(item, seen);
    if (reason) return reason;
  }
  seen.delete(val);
  return null;
}

function isVisible(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// 判断 mime/filename 是否被 file input 的 accept 允许：
// 逗号分隔，支持 image/* 通配与 .ext 扩展名形式；accept 为空视为不过滤（同浏览器行为）
function acceptMatches(accept: string, mime: string, filename: string): boolean {
  const mimeLower = mime.toLowerCase();
  const mimeType = mimeLower.split("/")[0] ?? "";
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  return accept
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .some((a) => {
      if (a.startsWith(".")) return `.${ext}` === a;
      if (a.endsWith("/*")) return mimeType === a.slice(0, -2);
      return a === mimeLower;
    });
}

function xpathStr(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return "concat('" + s.replace(/'/g, "',\"'\",'") + "')";
}

// 常用按键的 keyCode（XPath / KeyboardEvent 兼容层用；单字符键取 ASCII 码）
const KEY_CODE_MAP: Record<string, number> = {
  Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Insert: 45,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  " ": 32, Space: 32,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

// 纯修饰键：浏览器不会为它们产生 keypress 事件，跳过 keypress 派发
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock"]);

// 由 key 值推导 KeyboardEventInit：补全 keyCode/which（兼容旧式处理器）与 code（物理按键）
function keyboardEventInit(
  key: string,
  mods: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean },
): KeyboardEventInit {
  const single = key.length === 1;
  const keyCode = KEY_CODE_MAP[key] ?? (single ? key.toUpperCase().charCodeAt(0) : 0);
  const code = key === " " || key === "Space"
    ? "Space"
    : single
      ? (/[0-9]/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`)
      : key;
  return { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, ...mods };
}

// React 受控组件兼容的属性赋值：直接 el.value = x 会被 React 的 value tracker 拦截
// （change 事件到达时 React 比对 tracker 记录认为"值没变"而不更新 state），
// 走原型链原生 setter 可绕过 tracker，受控与非受控组件都生效。
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: unknown): void {
  const proto =
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
    HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, String(value));
  else (el as { value: string }).value = String(value);
}

function setNativeChecked(el: HTMLInputElement, checked: boolean): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
  if (setter) setter.call(el, checked);
  else el.checked = checked;
}

// base64（可带 data: URL 前缀）→ File
function base64ToFile(base64: string, filename: string, mime: string): File {
  const clean = base64.replace(/^data:[^;]+;base64,/, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}

// 按事件名选构造器：key* → KeyboardEvent、mouse* → MouseEvent，
// 其余（含自定义事件名）→ CustomEvent（options.detail 透传）
function constructTriggerEvent(name: string, init: Record<string, unknown>): Event {
  if (name.startsWith("key")) return new KeyboardEvent(name, init as KeyboardEventInit);
  if (name.startsWith("mouse")) return new MouseEvent(name, init as MouseEventInit);
  return new CustomEvent(name, init as CustomEventInit);
}

// --- Shadow DOM 穿透查找 ---
// 目标：元素命令透明穿透 open shadow root。
// 三种方式，从显式到隐式：
//   1. 路径标记 #shadow-root（可直接粘贴 DevTools 的完整元素路径）
//   2. 组合器 >>>（穿透所有层级，浏览器原生不支持，这里自行实现）
//   3. 兜底：裸选择器 / xpath / 文本在 light DOM 未命中时，按文档序自动搜索所有 open shadow root
// 限制：closed shadow root 无法访问（.shadowRoot 为 null），只能用坐标点击（real_click）。

// 收集 root 下所有 open shadow root（含嵌套），按文档序。
// root 为 Element 时也包含其自身的 shadowRoot（>>> 穿透宿主自身边界的场景，如 `my-host >>> button`）
function openShadowRootsDeep(root: Document | ShadowRoot | Element): ShadowRoot[] {
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
}

// 选择器是否含 shadow 标记（>>> 或 #shadow-root），跳过引号/括号内的出现
function hasShadowToken(sel: string): boolean {
  let quote: "'" | '"' | null = null;
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(" || ch === "[") { depth++; continue; }
    if (ch === ")" || ch === "]") { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (ch === ">" && sel[i + 1] === ">" && sel[i + 2] === ">") return true;
    if (ch === "#" && sel.startsWith("shadow-root", i + 1)) {
      const after = sel[i + 1 + "shadow-root".length];
      if (after === undefined || !/[a-zA-Z0-9_-]/.test(after)) return true;
    }
  }
  return false;
}

// 路径 token：CSS 段 / #shadow-root 边界 / >>> 边界
interface ShadowPathToken {
  kind: "css" | "shadowroot" | "pierce";
  value: string;
}

// 把含 shadow 标记的路径拆成 token（括号深度与引号感知，避免拆坏 :nth-child / [attr="a > b"]）
function tokenizeShadowPath(sel: string): ShadowPathToken[] {
  const tokens: ShadowPathToken[] = [];
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let cur = "";
  const flush = () => {
    const s = cur.trim();
    if (s) tokens.push({ kind: "css", value: s });
    cur = "";
  };
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") { depth++; cur += ch; continue; }
    if (ch === ")" || ch === "]") { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (depth > 0) { cur += ch; continue; }
    if (ch === ">" && sel[i + 1] === ">" && sel[i + 2] === ">") {
      flush();
      tokens.push({ kind: "pierce", value: ">>>" });
      i += 2;
      continue;
    }
    if (ch === ">") {
      flush();
      continue;
    }
    if (ch === "#" && sel.startsWith("shadow-root", i + 1)) {
      const after = sel[i + 1 + "shadow-root".length];
      if (after === undefined || !/[a-zA-Z0-9_-]/.test(after)) {
        flush();
        tokens.push({ kind: "shadowroot", value: "#shadow-root" });
        i += "shadow-root".length;
        continue;
      }
    }
    cur += ch;
  }
  flush();
  return tokens;
}

type ShadowCtx = Document | ShadowRoot | Element;

// 在上下文集合内匹配一个 CSS 段；未命中时兜底在 open shadow root 内再搜
// （宿主本身嵌在 shadow 里、或路径省略了 #shadow-root 标记时仍可用）
function matchCssSegment(segment: string, contexts: ShadowCtx[]): ShadowCtx[] {
  const out: ShadowCtx[] = [];
  for (const ctx of contexts) {
    try {
      for (const el of Array.from(ctx.querySelectorAll(segment))) out.push(el);
    } catch { /* 非法段选择器：跳过该上下文 */ }
  }
  if (out.length > 0) return out;
  for (const ctx of contexts) {
    for (const sr of openShadowRootsDeep(ctx)) {
      try {
        for (const el of Array.from(sr.querySelectorAll(segment))) out.push(el);
      } catch { /* 同上 */ }
    }
  }
  return out;
}

// 路径行走：CSS 段在当前候选内查找，#shadow-root 取宿主的 shadowRoot，>>> 穿透所有层。
// 返回全部命中（可能含 ShadowRoot 本身，调用方过滤 Element）。
function walkShadowPath(sel: string): ShadowCtx[] {
  const tokens = tokenizeShadowPath(sel);
  let cands: ShadowCtx[] = []; // 空 = 从 document 开始
  for (const tok of tokens) {
    if (tok.kind === "css") {
      const contexts = cands.length > 0 ? cands : [document];
      cands = Array.from(new Set(matchCssSegment(tok.value, contexts)));
      if (cands.length === 0) return [];
    } else if (tok.kind === "shadowroot") {
      cands = cands
        .filter((c): c is Element => c instanceof Element && !!c.shadowRoot)
        .map((c) => c.shadowRoot as ShadowRoot);
      if (cands.length === 0) return [];
    } else {
      // >>>
      const next: ShadowCtx[] = [];
      for (const c of cands) {
        for (const sr of openShadowRootsDeep(c)) next.push(sr);
      }
      cands = Array.from(new Set(next));
      if (cands.length === 0) return [];
    }
  }
  return cands;
}

function findCssPierced(css: string): Element | null {
  if (hasShadowToken(css)) {
    const hit = walkShadowPath(css).find((c): c is Element => c instanceof Element);
    return hit ?? null;
  }
  const direct = document.querySelector(css);
  if (direct) return direct;
  for (const sr of openShadowRootsDeep(document)) {
    const el = sr.querySelector(css);
    if (el) return el;
  }
  return null;
}

// 返回全部匹配（show / get_css 的 css: 分支用）；与 findElement 同为「light DOM 优先、shadow 兜底」
function findAllPierced(selector: string): Element[] {
  const css = selector.startsWith("css:") ? selector.slice(4) : selector;
  if (hasShadowToken(css)) {
    return walkShadowPath(css).filter((c): c is Element => c instanceof Element);
  }
  const direct = Array.from(document.querySelectorAll(css));
  if (direct.length > 0) return direct;
  const out: Element[] = [];
  for (const sr of openShadowRootsDeep(document)) {
    for (const el of Array.from(sr.querySelectorAll(css))) out.push(el);
  }
  return out;
}

function findXPathPierced(xpath: string): Element | null {
  const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  const direct = result.singleNodeValue as Element | null;
  if (direct) return direct;
  // ShadowRoot 不能作 XPath context node（#document-fragment 非法），按顶层子元素逐个求值
  for (const sr of openShadowRootsDeep(document)) {
    for (const child of Array.from(sr.children)) {
      try {
        const r = document.evaluate(xpath, child, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const hit = r.singleNodeValue as Element | null;
        if (hit) return hit;
      } catch { /* 绝对路径（如 /html/...）在 shadow tree 内无意义，跳过 */ }
    }
  }
  return null;
}

function findElement(selector: string): Element | null {
  if (selector.startsWith("css:")) {
    return findCssPierced(selector.slice(4));
  }
  if (selector.startsWith("xpath:")) {
    return findXPathPierced(selector.slice(6));
  }
  return findCssPierced(selector);
}

// 生成稳定可复用的 CSS 选择器（list_elements 返回，agent 可直接用于 click/type/upload_file 等）：
// 优先全局唯一 id；否则逐级构建 tag+前 2 个稳定类 / tag:nth-of-type 路径；
// 元素在 open shadow root 内时跨边界段用 >>> 连接（与 findElement 的穿透语义一致）
// rootDoc 参数：iframe 内元素传 el.ownerDocument（id 唯一性检查与 body 停止条件都要
// 在元素所属文档内判定，否则生成的选择器在子 frame 里查不到/误用顶层文档判唯一）。
function genSelector(el: Element, rootDoc: Document = document): string {
  const esc = (s: string) => CSS.escape(s);
  const nthOfType = (e: Element): number => {
    let n = 1;
    for (let sib = e.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.tagName === e.tagName) n++;
    }
    return n;
  };
  const segs: { seg: string; cross: boolean }[] = [];
  let cur: Element | null = el;
  let lastCross = false;
  while (cur && cur !== rootDoc.body && cur !== rootDoc.documentElement) {
    let seg: string;
    if (cur.id && rootDoc.querySelectorAll(`#${esc(cur.id)}`).length === 1) {
      seg = `#${esc(cur.id)}`;
      // 唯一 id 已能唯一定位，祖先路径全部冗余——截断，selector 短且不受祖先结构变化影响
      if (segs.length > 0) segs[0].cross = lastCross;
      segs.unshift({ seg, cross: false });
      break;
    } else {
      const cls = Array.from(cur.classList)
        .filter((c) => /^[a-zA-Z_][\w-]*$/.test(c))
        .slice(0, 2);
      if (cls.length > 0) {
        seg = `${cur.tagName.toLowerCase()}.${cls.join(".")}`;
      } else {
        seg = `${cur.tagName.toLowerCase()}:nth-of-type(${nthOfType(cur)})`;
      }
    }
    if (segs.length > 0) segs[0].cross = lastCross;
    segs.unshift({ seg, cross: false });
    const root = cur.getRootNode();
    if (root instanceof ShadowRoot) {
      cur = root.host;
      lastCross = true;
    } else {
      cur = cur.parentElement;
      lastCross = false;
    }
  }
  let out = "";
  for (let i = 0; i < segs.length; i++) {
    // cross 标记在"子段"上（入栈时 segs[0].cross = lastCross 记录的是该段与
    // 上一级父段之间的边界），连接符要读 segs[i].cross——读 segs[i-1].cross
    // 会把 shadow 边界错位成普通子级，产出 `#shHost > button`（不可复用）
    if (i > 0) out += segs[i].cross ? " >>> " : " > ";
    out += segs[i].seg;
  }
  return out || el.tagName.toLowerCase();
}

// 就绪信号：动态注入（chrome.scripting.executeScript）时告知 service worker 已注册完成；
// manifest 正常注入（all_frames）时由 service worker 常驻 listener 静默响应，无副作用。
chrome.runtime.sendMessage({ type: "cs_injected" }).catch(() => {});

// 调试模式桥：debug-mode.js 与 content-script.js 同属一个 content_scripts 项（同隔离世界、
// 同文档、按 js 数组顺序加载），后加载的 debug-mode.js 经 window.__cdaDebug 复用本文件的
// 命令执行与选择器生成，不重复实现也不改动上方任何逻辑。
const __cdaDebugBridge = {
  handleCommand,
  genSelector,
};
(window as unknown as { __cdaDebug?: unknown }).__cdaDebug = __cdaDebugBridge;
