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
      (el.style as Record<string, string>)[prop] = origVal;
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
  if (has("html")) info.html = document.documentElement.outerHTML;
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
        await new Promise((r) => setTimeout(r, 200));
        window.removeEventListener("beforeunload", onBeforeUnload);

        // Build response based on _field
        const data: Record<string, unknown> = { clickDesc };
        if (fields.length === 0 || needsField(fields, "navigated")) data.navigated = navigated;
        if (fields.length === 0 || needsField(fields, "current")) {
          const pageInfo = await collectPageInfo(fields);
          data.current = pageInfo;
        }
        if (fields.length === 0 || needsField(fields, "iframeChanged", "iframeChanges")) {
          data.iframeChanged = false;
          data.iframeChanges = [];
        }
        if (fields.length === 0 || needsField(fields, "newTabs")) {
          data.newTabs = [];
        }
        return { success: true, data };
      }

      case "get_rect": {
        // 获取元素在视口中的坐标（供 real_click 真实点击使用）。
        // iframe 内元素的 getBoundingClientRect 相对 iframe 自身视口，
        // 沿 window.parent 链累加每层 frameElement 的偏移换算为顶层视口坐标；
        // 跨域边界无法读父 frame（getBoundingClientRect 抛 SecurityError）→ 标记 crossOrigin，
        // 返回 iframe 本地坐标，由 service worker 走 CDP getContentQuads 精确定位。
        const selector = params.selector as string;
        const el = findElement(selector) as HTMLElement | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
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
        // 记录原样式值，hide 可精确还原。
        const selector = params.selector as string;
        const els = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
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
        const el = findElement(selector) as HTMLElement | null;
        if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
        // input/textarea: 直接设置 value
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true };
        }
        // contenteditable (富文本编辑器如 ProseMirror): 聚焦后用 execCommand 模拟真实输入
        if (el.isContentEditable) {
          el.focus();
          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand("delete", false);
          }
          // 按换行分段输入，保留段落结构
          const paragraphs = text.split(/\n+/).filter((s) => s.length > 0);
          paragraphs.forEach((para, i) => {
            document.execCommand("insertText", false, para);
            if (i < paragraphs.length - 1) document.execCommand("insertParagraph", false);
          });
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return { success: true };
        }
        return { success: false, error: `Element not typeable: ${selector} (tag=${el.tagName}, contentEditable=${el.contentEditable})` };
      }

      case "upload_file": {
        const selector = params.selector as string;
        const base64 = params.base64 as string;
        const filename = (params.filename as string) || "upload.png";
        const mime = (params.mime as string) || "image/png";
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
        return { success: true, data: { filename, size: bytes.length, mime } };
      }

      case "paste_rich": {
        // 向富文本编辑器(contenteditable)粘贴带样式的 HTML 内容，等价于粘贴一份排好版的文档
        const selector = params.selector as string;
        const html = params.html as string;
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
        return { success: true, data: { inserted: true } };
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
        const nodes = isCss ? document.querySelectorAll(query) : [findElement(selector)].filter(Boolean) as Element[];
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
          const cleanup = () => {
            document.removeEventListener("readystatechange", onChange);
            clearTimeout(timer);
          };
          const onChange = () => {
            if (document.readyState === "complete") {
              settled = true;
              cleanup();
              waitForDomStable(3000).then(() => {
                resolve({ success: true, data: { readyState: "complete", elapsed: Date.now() - start } });
              });
            }
          };
          document.addEventListener("readystatechange", onChange);
          if (document.readyState === "complete") {
            settled = true;
            cleanup();
            waitForDomStable(3000).then(() => {
              resolve({ success: true, data: { readyState: "complete", elapsed: Date.now() - start } });
            });
          } else {
            const timer = setTimeout(() => {
              if (settled) return;
              cleanup();
              resolve({ success: true, data: { readyState: document.readyState, elapsed: Date.now() - start } });
            }, timeout);
          }
        });
      }

      case "scroll": {
        const y = (params.y as number) ?? 0;
        const x = (params.x as number) ?? 0;
        window.scrollTo({ top: y, left: x, behavior: "smooth" });
        await waitForDomStable(3000);
        return { success: true, data: { scrollX: window.scrollX, scrollY: window.scrollY } };
      }

      default:
        return { success: false, error: `Unknown command: ${command}` };
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function waitForDomStable(maxWaitMs: number): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer: number;
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = window.setTimeout(() => {
        observer.disconnect();
        resolve();
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    quietTimer = window.setTimeout(() => {
      observer.disconnect();
      resolve();
    }, 500);
    setTimeout(() => {
      observer.disconnect();
      clearTimeout(quietTimer);
      resolve();
    }, maxWaitMs);
  });
}

function findByText(text: string): Element | null {
  const q = xpathStr(text);
  const hidden = "self::script or self::style or self::noscript or self::template or self::head or self::title or self::meta or self::svg or self::path";
  const xpath = [
    `//body//button[contains(normalize-space(.), ${q})]`,
    `//body//a[contains(normalize-space(.), ${q})]`,
    `//body//input[contains(@value, ${q})]`,
    `//body//*[not(${hidden})][contains(normalize-space(.), ${q}) and not(./*[not(${hidden})][contains(normalize-space(.), ${q})])]`,
  ].join(" | ");

  const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
  let el = result.iterateNext();
  while (el) {
    const htmlEl = el as HTMLElement;
    if (isVisible(htmlEl)) return htmlEl;
    el = result.iterateNext();
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

function findElement(selector: string): Element | null {
  if (selector.startsWith("css:")) {
    return document.querySelector(selector.slice(4));
  }
  if (selector.startsWith("xpath:")) {
    const xpath = selector.slice(6);
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue as Element | null;
  }
  return document.querySelector(selector);
}

// 就绪信号：动态注入（chrome.scripting.executeScript）时告知 service worker 已注册完成；
// manifest 正常注入（all_frames）时由 service worker 常驻 listener 静默响应，无副作用。
chrome.runtime.sendMessage({ type: "cs_injected" }).catch(() => {});
