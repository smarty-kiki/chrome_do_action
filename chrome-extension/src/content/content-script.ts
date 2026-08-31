// --- Persistent JS error collection ---
// Starts on page load, accumulates errors until explicitly cleared.
// Errors from window.onerror and unhandledrejection are captured.

const jsErrors: JsError[] = [];

function onPageError(ev: ErrorEvent) {
  jsErrors.push({ message: ev.message, source: ev.filename, lineno: ev.lineno });
}

function onUnhandledRejection(ev: PromiseRejectionEvent) {
  const reason = ev.reason;
  const msg = typeof reason === "string" ? reason : reason?.message ?? String(reason);
  jsErrors.push({ message: `Unhandled rejection: ${msg}`, source: "unhandledrejection" });
}

window.addEventListener("error", onPageError);
window.addEventListener("unhandledrejection", onUnhandledRejection);

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
      if (includeJsErrors && jsErrors.length > 0) {
        const withErrors = { ...result, jsErrors: [...jsErrors] };
        if (command === "click") {
          const { jsErrors: _, ...rest } = withErrors;
          return rest;
        }
        return withErrors;
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
        let el: Element;
        let clickDesc: Record<string, unknown> = {};

        // 派发完整鼠标事件序列（mousedown/mouseup/click），对 Vue/React 事件委托更可靠
        const dispatchFullClick = (target: Element, x?: number, y?: number) => {
          const rect = (target as HTMLElement).getBoundingClientRect();
          const cx = x ?? rect.left + rect.width / 2;
          const cy = y ?? rect.top + rect.height / 2;
          const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
          target.dispatchEvent(new MouseEvent("mousedown", opts));
          target.dispatchEvent(new MouseEvent("mouseup", opts));
          target.dispatchEvent(new MouseEvent("click", opts));
        };

        if (params.text) {
          const text = params.text as string;
          const found = findByText(text);
          if (!found) return { success: false, notFound: true, error: `No element found with text: ${text}` };
          el = found;
          clickDesc = { text, tag: (el as HTMLElement).tagName.toLowerCase() };
          dispatchFullClick(el);
        } else if (params.x !== undefined && params.y !== undefined) {
          const x = params.x as number;
          const y = params.y as number;
          const found = document.elementFromPoint(x, y);
          if (!found) return { success: false, notFound: true, error: `No element at (${x}, ${y})` };
          el = found;
          clickDesc = { x, y, tag: (el as HTMLElement).tagName.toLowerCase() };
          dispatchFullClick(el, x, y);
        } else {
          const selector = params.selector as string;
          if (!selector) return { success: false, error: "Need text, selector, or {x,y}" };
          const found = findElement(selector);
          if (!found) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          el = found;
          clickDesc = { selector, tag: (el as HTMLElement).tagName.toLowerCase() };
          dispatchFullClick(el);
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

      case "get_rect": {
        // 获取元素在视口中的坐标（供 real_click 真实点击使用）。
        // iframe 内元素的 getBoundingClientRect 相对 iframe 自身视口，
        // 沿 window.parent 链累加每层 frameElement 的偏移换算为顶层视口坐标；
        // 跨域边界无法读父 frame（getBoundingClientRect 抛 SecurityError）→ 标记 crossOrigin，
        // 返回 iframe 本地坐标，由 service worker 走 CDP getContentQuads 精确定位。
        const selector = params.selector as string;
        if (!selector && !params.text) return { success: false, error: 'Need "selector" or "text" parameter' };
        const el = (params.text ? findByText(params.text) : findElement(selector)) as HTMLElement | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${params.text || selector}` };
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
        const selector = params.selector as string;
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
        const selector = params.selector as string;
        const text = params.text as string;
        const mode = (params.mode as string) || "replace";
        if (!selector) return { success: false, error: 'Need "selector" parameter' };
        if (text == null) return { success: false, error: 'Need "text" parameter' };
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
          // 按换行分段输入，保留段落结构（insertText 天然替换当前选区）
          const paragraphs = text.split(/\n+/).filter((s) => s.length > 0);
          paragraphs.forEach((para, i) => {
            document.execCommand("insertText", false, para);
            if (i < paragraphs.length - 1) document.execCommand("insertParagraph", false);
          });
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
        const key = params.key as string | undefined;
        if (!key) return { success: false, error: 'Need "key" parameter (e.g. Enter, Escape, Tab, ArrowDown, "a")' };
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
        const selector = params.selector as string;
        const base64 = params.base64 as string;
        const filename = (params.filename as string) || "upload.png";
        const mime = (params.mime as string) || "image/png";
        if (!selector) return { success: false, error: 'Need "selector" parameter' };
        if (!base64) return { success: false, error: 'Need "base64" parameter' };
        const el = findElement(selector) as HTMLInputElement | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
        if (!(el instanceof HTMLInputElement) || el.type !== "file") {
          return { success: false, error: `Element is not a file input: ${selector}` };
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
        if (!selector) return { success: false, error: 'Need "selector" parameter' };
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
          const filename = (data.filename as string) || "upload.png";
          const mime = (data.mime as string) || "image/png";
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
            const name = (data.filename as string) || url.split("/").pop() || "download";
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
        // 向富文本编辑器(contenteditable)粘贴带样式的 HTML 内容，等价于粘贴一份排好版的文档
        const selector = params.selector as string;
        const html = params.html as string;
        if (!selector) return { success: false, error: 'Need "selector" parameter' };
        if (html == null) return { success: false, error: 'Need "html" parameter' };
        const el = findElement(selector) as HTMLElement | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
        if (!el.isContentEditable) {
          return { success: false, error: `Element is not contenteditable: ${selector} (tag=${el.tagName})` };
        }
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand("delete", false);
        }
        // 直接操作 clipboardData 不可行，用 execCommand insertHTML 保留样式
        document.execCommand("insertHTML", false, html);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        // 等影响落地：编辑器收到内容后的重排/防抖渲染完成再返回
        const stable = await waitForSettled(3000);
        const waitForResult = params.waitFor
          ? await waitForCondition(params.waitFor as { selector?: string; text?: string }, 3000)
          : null;
        const pasteData: Record<string, unknown> = {
          selector,
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
        if (!selector) return { success: false, error: 'Need "selector" parameter' };
        if (!event) {
          return { success: false, error: 'Need "event" parameter (e.g. "change", "blur", "focus", "input", "select", or a custom event name)' };
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
        const selector = params.selector as string;
        const el = selector ? findElement(selector) : document.body;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
        return { success: true, data: el.textContent?.trim() };
      }

      case "get_css": {
        const selector = params.selector as string;
        if (!selector) return { success: false, error: "selector is required" };
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

      case "get_js_errors": {
        return { success: true, data: { errors: [...jsErrors], count: jsErrors.length } };
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
    return { success: false, error: String(err) };
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
    let quiet: { cancel: () => void } | undefined;
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
      const observeRoot = (root: Document | ShadowRoot) => {
        try {
          domObserver?.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
        } catch { /* 单个 root 失败忽略 */ }
      };
      observeRoot(document.body);
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
  const start = Date.now();
  const check = () => {
    if (waitFor.text) return !!findByText(waitFor.text);
    if (waitFor.selector) {
      const el = findElement(waitFor.selector) as HTMLElement | null;
      return !!el && isVisible(el);
    }
    return false;
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
function evalTextXPath(xpath: string, context: Document | ShadowRoot): Element | null {
  // Chrome 的 document.evaluate 不接受 ShadowRoot（#document-fragment）作 context node，
  // 对 shadow tree 改按顶层子元素逐个求值（// 相对 context 节点展开，覆盖整棵子树）
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

function isVisible(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
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

// 就绪信号：动态注入（chrome.scripting.executeScript）时告知 service worker 已注册完成；
// manifest 正常注入（all_frames）时由 service worker 常驻 listener 静默响应，无副作用。
chrome.runtime.sendMessage({ type: "cs_injected" }).catch(() => {});
