chrome.runtime.onMessage.addListener(
  (msg: { type: string; id?: string; payload: { command: string; params?: Record<string, unknown> } },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (res: { success: boolean; data?: unknown; error?: string }) => void) => {
    if (msg.type === "execute_command") {
      handleCommand(msg.id!, msg.payload).then(sendResponse);
    }
    return true;
  },
);

async function handleCommand(
  _id: string,
  payload: { command: string; params?: Record<string, unknown> },
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { command, params = {} } = payload;

  try {
    switch (command) {
      case "click": {
        let el: Element;
        let clickDesc: Record<string, unknown> = {};

        if (params.text) {
          // 按可见文字查找元素
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

        // 等 300ms 检测是否触发页面跳转
        let navigated = false;
        const onBeforeUnload = () => { navigated = true; };
        window.addEventListener("beforeunload", onBeforeUnload, { once: true });
        await new Promise((r) => setTimeout(r, 300));
        window.removeEventListener("beforeunload", onBeforeUnload);

        return { success: true, navigated, data: clickDesc };
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

      case "get_title":
        return { success: true, data: document.title };

      case "get_html": {
        const selector = params.selector as string;
        const el = selector ? findElement(selector) : document.documentElement;
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        return { success: true, data: (el as HTMLElement).outerHTML || el.textContent };
      }

      case "get_url":
        return { success: true, data: window.location.href };

      case "scroll": {
        const y = (params.y as number) ?? 0;
        window.scrollTo({ top: y, behavior: "smooth" });
        await waitForDomStable(3000);
        return { success: true, data: { scrollY: window.scrollY } };
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
    // 兜底：超时也返回
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
