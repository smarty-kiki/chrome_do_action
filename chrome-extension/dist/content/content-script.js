"use strict";
(() => {
  // src/content/content-script.ts
  var jsErrors = [];
  function onPageError(ev) {
    jsErrors.push({ message: ev.message, source: ev.filename, lineno: ev.lineno });
  }
  function onUnhandledRejection(ev) {
    const reason = ev.reason;
    const msg = typeof reason === "string" ? reason : reason?.message ?? String(reason);
    jsErrors.push({ message: `Unhandled rejection: ${msg}`, source: "unhandledrejection" });
  }
  window.addEventListener("error", onPageError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  chrome.runtime.onMessage.addListener(
    (msg, _sender, sendResponse) => {
      if (msg.type !== "execute_command") return;
      const { command } = msg.payload;
      const fields = getFieldFilter(msg.payload.params);
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
    }
  );
  function getFieldFilter(params) {
    return params._field || [];
  }
  function needsField(fields, ...candidates) {
    if (fields.length === 0) return true;
    return candidates.some((c) => fields.includes(c));
  }
  async function collectPageInfo(fields) {
    const info = {};
    const has = (name) => fields.length === 0 || fields.some((f) => f === name || f === `currentTab.${name}`);
    if (has("url")) info.url = window.location.href;
    if (has("title")) info.title = document.title;
    if (has("html")) info.html = document.documentElement.outerHTML;
    return info;
  }
  async function collectIframes(fields) {
    if (fields.length > 0 && !fields.includes("iframes")) return [];
    const iframes = [];
    document.querySelectorAll("iframe").forEach((f, i) => {
      const iframe = f;
      let sameOrigin = false;
      let url;
      let html;
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
      iframes.push({ index: i, src: iframe.src, sameOrigin, ...sameOrigin ? { url, html } : {} });
    });
    return iframes;
  }
  async function handleCommand(payload) {
    const { command, params = {} } = payload;
    const fields = getFieldFilter(params);
    try {
      switch (command) {
        case "click": {
          let el;
          let clickDesc = {};
          if (params.text) {
            const text = params.text;
            const found = findByText(text);
            if (!found) return { success: false, error: `No element found with text: ${text}` };
            el = found;
            clickDesc = { text, tag: el.tagName.toLowerCase() };
            el.click();
          } else if (params.x !== void 0 && params.y !== void 0) {
            const x = params.x;
            const y = params.y;
            const found = document.elementFromPoint(x, y);
            if (!found) return { success: false, error: `No element at (${x}, ${y})` };
            el = found;
            clickDesc = { x, y, tag: el.tagName.toLowerCase() };
            el.dispatchEvent(new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              view: window
            }));
          } else {
            const selector = params.selector;
            if (!selector) return { success: false, error: "Need text, selector, or {x,y}" };
            const found = findElement(selector);
            if (!found) return { success: false, error: `Element not found: ${selector}` };
            el = found;
            clickDesc = { selector, tag: el.tagName.toLowerCase() };
            el.click();
          }
          let navigated = false;
          const onBeforeUnload = () => {
            navigated = true;
          };
          window.addEventListener("beforeunload", onBeforeUnload, { once: true });
          await new Promise((r) => setTimeout(r, 300));
          window.removeEventListener("beforeunload", onBeforeUnload);
          const data = { clickDesc };
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
          const selector = params.selector;
          const text = params.text;
          const el = findElement(selector);
          if (!el) return { success: false, error: `Element not found: ${selector}` };
          el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return { success: true };
        }
        case "get_text": {
          const selector = params.selector;
          const el = selector ? findElement(selector) : document.body;
          if (!el) return { success: false, error: `Element not found: ${selector}` };
          return { success: true, data: el.textContent?.trim() };
        }
        case "get_page_info": {
          const [pageInfo, iframes] = await Promise.all([
            collectPageInfo(fields),
            collectIframes(fields)
          ]);
          const data = { ...pageInfo };
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
          const timeout = params.timeout ?? 1e4;
          const start = Date.now();
          return new Promise((resolve) => {
            const CHECK_INTERVAL = 200;
            let timer;
            const check = () => {
              const elapsed = Date.now() - start;
              if (elapsed >= timeout) {
                cleanup();
                resolve({ success: true, data: { readyState: document.readyState, elapsed } });
                return;
              }
              if (document.readyState === "complete") {
                cleanup();
                waitForDomSettle(Math.min(timeout - (Date.now() - start), 3e3)).then(() => {
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
          const y = params.y ?? 0;
          const x = params.x ?? 0;
          window.scrollTo({ top: y, left: x, behavior: "smooth" });
          await waitForDomStable(3e3);
          return { success: true, data: { scrollX: window.scrollX, scrollY: window.scrollY } };
        }
        default:
          return { success: false, error: `Unknown command: ${command}` };
      }
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
  function waitForDomStable(maxWaitMs) {
    return new Promise((resolve) => {
      let quietTimer;
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
  function waitForDomSettle(maxWaitMs) {
    return new Promise((resolve) => {
      const INTERVAL = 200;
      const QUIET_MS = 500;
      let lastHtml = document.body.innerHTML;
      let stableSince = Date.now();
      let timer;
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
  function findByText(text) {
    const q = xpathStr(text);
    const hidden = "self::script or self::style or self::noscript or self::template or self::head or self::title or self::meta or self::svg or self::path";
    const xpath = [
      `//body//button[contains(normalize-space(.), ${q})]`,
      `//body//a[contains(normalize-space(.), ${q})]`,
      `//body//input[contains(@value, ${q})]`,
      `//body//*[not(${hidden})][contains(normalize-space(.), ${q}) and not(./*[not(${hidden})][contains(normalize-space(.), ${q})])]`
    ].join(" | ");
    const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    let el = result.iterateNext();
    while (el) {
      const htmlEl = el;
      if (isVisible(htmlEl)) return htmlEl;
      el = result.iterateNext();
    }
    return null;
  }
  function isVisible(el) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function xpathStr(s) {
    if (!s.includes("'")) return `'${s}'`;
    if (!s.includes('"')) return `"${s}"`;
    return "concat('" + s.replace(/'/g, `',"'",'`) + "')";
  }
  function findElement(selector) {
    if (selector.startsWith("css:")) {
      return document.querySelector(selector.slice(4));
    }
    if (selector.startsWith("xpath:")) {
      const xpath = selector.slice(6);
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    }
    return document.querySelector(selector);
  }
})();
