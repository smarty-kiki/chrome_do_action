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
  var showRegistry = /* @__PURE__ */ new Map();
  function restoreShownElement(el) {
    const orig = showRegistry.get(el);
    if (!orig) return;
    const restoreProp = (prop, origVal) => {
      if (origVal) {
        el.style[prop] = origVal;
      } else {
        el.style.removeProperty(prop);
      }
    };
    restoreProp("visibility", orig.visibility);
    restoreProp("opacity", orig.opacity);
    restoreProp("display", orig.display);
    showRegistry.delete(el);
  }
  chrome.runtime.onMessage.addListener(
    (msg, _sender, sendResponse) => {
      if (msg.type !== "execute_command") return;
      const { command } = msg.payload;
      const fields = msg.payload.params?._field || [];
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
          const dispatchFullClick = (target, x, y) => {
            const rect = target.getBoundingClientRect();
            const cx = x ?? rect.left + rect.width / 2;
            const cy = y ?? rect.top + rect.height / 2;
            const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
            target.dispatchEvent(new MouseEvent("mousedown", opts));
            target.dispatchEvent(new MouseEvent("mouseup", opts));
            target.dispatchEvent(new MouseEvent("click", opts));
          };
          if (params.text) {
            const text = params.text;
            const found = findByText(text);
            if (!found) return { success: false, error: `No element found with text: ${text}` };
            el = found;
            clickDesc = { text, tag: el.tagName.toLowerCase() };
            dispatchFullClick(el);
          } else if (params.x !== void 0 && params.y !== void 0) {
            const x = params.x;
            const y = params.y;
            const found = document.elementFromPoint(x, y);
            if (!found) return { success: false, error: `No element at (${x}, ${y})` };
            el = found;
            clickDesc = { x, y, tag: el.tagName.toLowerCase() };
            dispatchFullClick(el, x, y);
          } else {
            const selector = params.selector;
            if (!selector) return { success: false, error: "Need text, selector, or {x,y}" };
            const found = findElement(selector);
            if (!found) return { success: false, error: `Element not found: ${selector}` };
            el = found;
            clickDesc = { selector, tag: el.tagName.toLowerCase() };
            dispatchFullClick(el);
          }
          let navigated = false;
          const onBeforeUnload = () => {
            navigated = true;
          };
          window.addEventListener("beforeunload", onBeforeUnload, { once: true });
          await new Promise((r) => setTimeout(r, 200));
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
        case "get_rect": {
          const selector = params.selector;
          const el = findElement(selector);
          if (!el) return { success: false, error: `Element not found: ${selector}` };
          const rect = el.getBoundingClientRect();
          return {
            success: true,
            data: {
              selector,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          };
        }
        case "show": {
          const selector = params.selector;
          const els = Array.from(document.querySelectorAll(selector));
          if (els.length === 0) return { success: false, error: `Element not found: ${selector}` };
          for (const el of els) {
            if (!showRegistry.has(el)) {
              showRegistry.set(el, {
                visibility: el.style.visibility || void 0,
                opacity: el.style.opacity || void 0,
                display: el.style.display || void 0
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
          const selector = params.selector;
          const text = params.text;
          const el = findElement(selector);
          if (!el) return { success: false, error: `Element not found: ${selector}` };
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { success: true };
          }
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
          const selector = params.selector;
          const base64 = params.base64;
          const filename = params.filename || "upload.png";
          const mime = params.mime || "image/png";
          const el = findElement(selector);
          if (!el) return { success: false, error: `Element not found: ${selector}` };
          if (!(el instanceof HTMLInputElement) || el.type !== "file") {
            return { success: false, error: `Element is not a file input: ${selector}` };
          }
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
          const selector = params.selector;
          const html = params.html;
          const el = findElement(selector);
          if (!el) return { success: false, error: `Element not found: ${selector}` };
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
          document.execCommand("insertHTML", false, html);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return { success: true, data: { inserted: true } };
        }
        case "get_text": {
          const selector = params.selector;
          const el = selector ? findElement(selector) : document.body;
          if (!el) return { success: false, error: `Element not found: ${selector}` };
          return { success: true, data: el.textContent?.trim() };
        }
        case "get_css": {
          const selector = params.selector;
          if (!selector) return { success: false, error: "selector is required" };
          const isCss = selector.startsWith("css:");
          const query = isCss ? selector.slice(4) : selector;
          const nodes = isCss ? document.querySelectorAll(query) : [findElement(selector)].filter(Boolean);
          if (nodes.length === 0) return { success: false, error: `Element not found: ${selector}` };
          const results = Array.from(nodes).map((el, i) => {
            const computed = window.getComputedStyle(el);
            const css = {};
            for (let j = 0; j < computed.length; j++) {
              const prop = computed[j];
              css[prop] = computed.getPropertyValue(prop);
            }
            return { index: i, css };
          });
          return { success: true, data: { selector, count: nodes.length, results } };
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
            let settled = false;
            const cleanup = () => {
              document.removeEventListener("readystatechange", onChange);
              clearTimeout(timer);
            };
            const onChange = () => {
              if (document.readyState === "complete") {
                settled = true;
                cleanup();
                waitForDomStable(3e3).then(() => {
                  resolve({ success: true, data: { readyState: "complete", elapsed: Date.now() - start } });
                });
              }
            };
            document.addEventListener("readystatechange", onChange);
            if (document.readyState === "complete") {
              settled = true;
              cleanup();
              waitForDomStable(3e3).then(() => {
                resolve({ success: true, data: { readyState: "complete", elapsed: Date.now() - start } });
              });
            } else {
              const timer2 = setTimeout(() => {
                if (settled) return;
                cleanup();
                resolve({ success: true, data: { readyState: document.readyState, elapsed: Date.now() - start } });
              }, timeout);
            }
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
