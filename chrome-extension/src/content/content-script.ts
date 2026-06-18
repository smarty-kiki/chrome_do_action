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

// --- Command handler ---

chrome.runtime.onMessage.addListener(
  (msg: { type: string; id?: string; payload: { command: string; params?: Record<string, unknown> } },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (res: { success: boolean; data?: unknown; error?: string; jsErrors?: JsError[] }) => void) => {
    if (msg.type !== "execute_command") return;
    const { command } = msg.payload;

    // jsErrors are returned inline when explicitly requested via _field
    const fields = getFieldFilter(msg.payload.params as Record<string, string[]> | undefined);
    const includeJsErrors = fields.length === 0 || fields.includes("jsErrors");
    const exec = () => handleCommand(msg.payload);
    const promise = exec().then((result) => {
      if (includeJsErrors && jsErrors.length > 0) {
        return { ...result, jsErrors: [...jsErrors] };
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
  if (fields.length === 0 || fields.includes("url")) info.url = window.location.href;
  if (fields.length === 0 || fields.includes("title")) info.title = document.title;
  if (fields.length === 0 || fields.includes("html")) info.html = document.documentElement.outerHTML;
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
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { command, params = {} } = payload;
  const fields = getFieldFilter(params);

  try {
    switch (command) {
      case "click": {
        let el: Element;
        let clickDesc: Record<string, unknown> = {};

        if (params.text) {
          const text = params.text as string;
          const found = findByText(text);
          if (!found) return { success: false, error: `No element found with text: ${text}` };
          el = found;
          clickDesc = { text, tag: (el as HTMLElement).tagName.toLowerCase() };
          (el as HTMLElement).click();
        } else if (params.x !== undefined && params.y !== undefined) {
          const x = params.x as number;
          const y = params.y as number;
          const found = document.elementFromPoint(x, y);
          if (!found) return { success: false, error: `No element at (${x}, ${y})` };
          el = found;
          clickDesc = { x, y, tag: (el as HTMLElement).tagName.toLowerCase() };
          el.dispatchEvent(new MouseEvent("click", {
            bubbles: true, cancelable: true, clientX: x, clientY: y, view: window,
          }));
        } else {
          const selector = params.selector as string;
          if (!selector) return { success: false, error: "Need text, selector, or {x,y}" };
          const found = findElement(selector);
          if (!found) return { success: false, error: `Element not found: ${selector}` };
          el = found;
          clickDesc = { selector, tag: (el as HTMLElement).tagName.toLowerCase() };
          (el as HTMLElement).click();
        }

        let navigated = false;
        const onBeforeUnload = () => { navigated = true; };
        window.addEventListener("beforeunload", onBeforeUnload, { once: true });
        await new Promise((r) => setTimeout(r, 300));
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

      case "type": {
        const selector = params.selector as string;
        const text = params.text as string;
        const el = findElement(selector) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return { success: true };
      }

      case "get_text": {
        const selector = params.selector as string;
        const el = selector ? findElement(selector) : document.body;
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        return { success: true, data: el.textContent?.trim() };
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
          const CHECK_INTERVAL = 200;
          let timer: number;

          const check = () => {
            const elapsed = Date.now() - start;
            if (elapsed >= timeout) {
              cleanup();
              resolve({ success: true, data: { readyState: document.readyState, elapsed } });
              return;
            }
            if (document.readyState === "complete") {
              cleanup();
              waitForDomSettle(Math.min(timeout - (Date.now() - start), 3000)).then(() => {
                resolve({ success: true, data: { readyState: "complete", elapsed: Date.now() - start } });
              });
              return;
            }
            timer = window.setTimeout(check, CHECK_INTERVAL);
          };

          const cleanup = () => window.clearTimeout(timer);
          timer = window.setTimeout(check, CHECK_INTERVAL);
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
      }, 500);
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

/** Wait for DOM to stop changing by polling innerHTML every 200ms */
function waitForDomSettle(maxWaitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const INTERVAL = 200;
    const QUIET_MS = 500;
    let lastHtml = document.body.innerHTML;
    let stableSince = Date.now();
    let timer: number;

    const check = () => {
      const now = Date.now();
      if (now - stableSince >= QUIET_MS) {
        cleanup();
        resolve();
        return;
      }
      const currentHtml = document.body.innerHTML;
      if (currentHtml !== lastHtml) {
        lastHtml = currentHtml;
        stableSince = now;
      }
      timer = window.setTimeout(check, INTERVAL);
    };

    const cleanup = () => window.clearTimeout(timer);
    timer = window.setTimeout(check, INTERVAL);

    setTimeout(() => {
      cleanup();
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
