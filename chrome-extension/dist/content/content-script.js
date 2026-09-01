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
    if (has("html")) {
      const docEl = document.documentElement;
      info.html = typeof docEl.getHTML === "function" ? docEl.getHTML({ shadowRoots: openShadowRootsDeep(document) }) : document.documentElement.outerHTML;
    }
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
            if (!found) return { success: false, notFound: true, error: `No element found with text: ${text}` };
            el = found;
            clickDesc = { text, tag: el.tagName.toLowerCase() };
            dispatchFullClick(el);
          } else if (params.x !== void 0 && params.y !== void 0) {
            const x = params.x;
            const y = params.y;
            const found = document.elementFromPoint(x, y);
            if (!found) return { success: false, notFound: true, error: `No element at (${x}, ${y})` };
            el = found;
            clickDesc = { x, y, tag: el.tagName.toLowerCase() };
            dispatchFullClick(el, x, y);
          } else {
            const selector = params.selector;
            if (!selector) return { success: false, error: "Need text, selector, or {x,y}" };
            const found = findElement(selector);
            if (!found) return { success: false, notFound: true, error: `Element not found: ${selector}` };
            el = found;
            clickDesc = { selector, tag: el.tagName.toLowerCase() };
            dispatchFullClick(el);
          }
          let navigated = false;
          const onBeforeUnload = () => {
            navigated = true;
          };
          window.addEventListener("beforeunload", onBeforeUnload, { once: true });
          const stable = await waitForSettled(3e3);
          window.removeEventListener("beforeunload", onBeforeUnload);
          const waitForResult = params.waitFor ? await waitForCondition(params.waitFor, 3e3) : null;
          const data = { clickDesc, settledMs: stable.waited };
          if (waitForResult) data.waitFor = waitForResult;
          if (fields.length === 0 || needsField(fields, "navigated")) data.navigated = navigated;
          if (fields.length === 0 || needsField(fields, "current")) {
            const pageInfo = await collectPageInfo(fields);
            data.current = pageInfo;
          }
          return { success: true, data };
        }
        case "get_rect": {
          const selector = params.selector;
          if (!selector && !params.text) return { success: false, error: 'Need "selector" or "text" parameter' };
          const el = params.text ? findByText(params.text) : findElement(selector);
          if (!el) return { success: false, notFound: true, error: `Element not found: ${params.text || selector}` };
          const rect = el.getBoundingClientRect();
          const lx = rect.left + rect.width / 2;
          const ly = rect.top + rect.height / 2;
          let x = lx;
          let y = ly;
          let crossOrigin = false;
          let win = window;
          while (win.frameElement) {
            try {
              const fr = win.frameElement.getBoundingClientRect();
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
              ...crossOrigin ? { crossOrigin: true, localX: Math.round(lx), localY: Math.round(ly) } : {}
            }
          };
        }
        case "show": {
          const selector = params.selector;
          const els = findAllPierced(selector);
          if (els.length === 0) return { success: false, notFound: true, error: `Element not found: ${selector}` };
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
          const mode = params.mode || "replace";
          if (!selector) return { success: false, error: 'Need "selector" parameter' };
          if (text == null) return { success: false, error: 'Need "text" parameter' };
          if (mode !== "replace" && mode !== "append" && mode !== "insert") {
            return { success: false, error: `Invalid mode: ${mode} (expected replace|append|insert)` };
          }
          const el = findElement(selector);
          if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            if (mode === "replace") {
              el.value = text;
            } else {
              el.focus();
              if (mode === "append") {
                const end = el.value.length;
                el.value = el.value.slice(0, end) + text;
                el.setSelectionRange(end + text.length, end + text.length);
              } else {
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
          if (el.isContentEditable) {
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
                const anchor = sel.anchorNode;
                if (!(anchor instanceof Node) || !el.contains(anchor)) {
                  range.selectNodeContents(el);
                  range.collapse(false);
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
              }
            }
            const paragraphs = text.split(/\n+/).filter((s) => s.length > 0);
            paragraphs.forEach((para, i) => {
              document.execCommand("insertText", false, para);
              if (i < paragraphs.length - 1) document.execCommand("insertParagraph", false);
            });
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const stable = await waitForSettled(3e3);
          const waitForResult = params.waitFor ? await waitForCondition(params.waitFor, 3e3) : null;
          const typeData = { selector, mode, tag: el.tagName.toLowerCase(), settledMs: stable.waited };
          if (waitForResult) typeData.waitFor = waitForResult;
          return { success: true, data: typeData };
        }
        case "keyboard": {
          const key = params.key;
          if (!key) return { success: false, error: 'Need "key" parameter (e.g. Enter, Escape, Tab, ArrowDown, "a")' };
          const selector = params.selector;
          let el = null;
          if (selector) {
            el = findElement(selector);
            if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          } else {
            el = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
          }
          const target = el;
          try {
            target.focus({ preventScroll: true });
          } catch {
          }
          const mods = {
            ctrlKey: !!params.ctrl,
            shiftKey: !!params.shift,
            altKey: !!params.alt,
            metaKey: !!params.meta
          };
          const init = keyboardEventInit(key, mods);
          target.dispatchEvent(new KeyboardEvent("keydown", init));
          if (!MODIFIER_KEYS.has(key)) target.dispatchEvent(new KeyboardEvent("keypress", init));
          target.dispatchEvent(new KeyboardEvent("keyup", init));
          const stable = await waitForSettled(3e3);
          const waitForResult = params.waitFor ? await waitForCondition(params.waitFor, 3e3) : null;
          const keyData = {
            key,
            ...selector ? { selector } : {},
            tag: target.tagName.toLowerCase(),
            modifiers: mods,
            settledMs: stable.waited
          };
          if (waitForResult) keyData.waitFor = waitForResult;
          return { success: true, data: keyData };
        }
        case "upload_file": {
          const selector = params.selector;
          const base64 = params.base64;
          const filename = params.filename || "upload.png";
          const mime = params.mime || "image/png";
          if (!selector) return { success: false, error: 'Need "selector" parameter' };
          if (!base64) return { success: false, error: 'Need "base64" parameter' };
          const el = findElement(selector);
          if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          if (!(el instanceof HTMLInputElement) || el.type !== "file") {
            return { success: false, error: `Element is not a file input: ${selector}` };
          }
          if (el.accept && !acceptMatches(el.accept, mime, filename)) {
            return { success: false, error: `File type not accepted by input: mime=${mime} filename=${filename}, accept="${el.accept}"` };
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
          const stable = await waitForSettled(3e3);
          const waitForResult = params.waitFor ? await waitForCondition(params.waitFor, 3e3) : null;
          const uploadData = {
            selector,
            tag: el.tagName.toLowerCase(),
            filename,
            size: bytes.length,
            mime,
            settledMs: stable.waited
          };
          if (waitForResult) uploadData.waitFor = waitForResult;
          return { success: true, data: uploadData };
        }
        case "upload_dragdrop": {
          const selector = params.selector;
          const data = params.data;
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
          if (data.base64 !== void 0 === (data.url !== void 0)) {
            return { success: false, error: '"data" must have exactly one of "base64" or "url"' };
          }
          const el = findElement(selector);
          if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          let file;
          if (data.base64 !== void 0) {
            const filename = data.filename || "upload.png";
            const mime = data.mime || "image/png";
            try {
              file = base64ToFile(data.base64, filename, mime);
            } catch {
              return { success: false, error: "Invalid base64 in data" };
            }
          } else {
            const url = data.url;
            try {
              const resp = await fetch(url);
              if (!resp.ok) {
                return { success: false, error: `Failed to fetch url: ${url} (HTTP ${resp.status})` };
              }
              const blob = await resp.blob();
              const name = data.filename || url.split("/").pop() || "download";
              file = new File([blob], name, { type: blob.type || "application/octet-stream" });
            } catch (e) {
              return { success: false, error: `Failed to fetch url: ${url} (${e.message})` };
            }
          }
          const dt = new DataTransfer();
          dt.items.add(file);
          for (const type of ["dragenter", "dragover", "drop"]) {
            el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
          }
          const stable = await waitForSettled(3e3);
          const waitForResult = params.waitFor ? await waitForCondition(params.waitFor, 3e3) : null;
          const dropData = {
            selector,
            tag: el.tagName.toLowerCase(),
            filename: file.name,
            size: file.size,
            mime: file.type,
            settledMs: stable.waited
          };
          if (waitForResult) dropData.waitFor = waitForResult;
          return { success: true, data: dropData };
        }
        case "paste_rich": {
          const selector = params.selector;
          const html = params.html;
          if (!selector) return { success: false, error: 'Need "selector" parameter' };
          if (html == null) return { success: false, error: 'Need "html" parameter' };
          const el = findElement(selector);
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
          document.execCommand("insertHTML", false, html);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          const stable = await waitForSettled(3e3);
          const waitForResult = params.waitFor ? await waitForCondition(params.waitFor, 3e3) : null;
          const pasteData = {
            selector,
            tag: el.tagName.toLowerCase(),
            inserted: true,
            settledMs: stable.waited
          };
          if (waitForResult) pasteData.waitFor = waitForResult;
          return { success: true, data: pasteData };
        }
        case "trigger": {
          const selector = params.selector;
          const event = params.event;
          if (!selector) return { success: false, error: 'Need "selector" parameter' };
          if (!event) {
            return { success: false, error: 'Need "event" parameter (e.g. "change", "blur", "focus", "input", "select", or a custom event name)' };
          }
          const known = ["selector", "event", "value", "options", "frame", "waitFor"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown trigger parameter(s): ${unknown.join(", ")} (expected selector, event, value, options)` };
          }
          const el = findElement(selector);
          if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          let valueApplied = false;
          if (params.value !== void 0) {
            if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
              let checked;
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
          let options = {};
          if (params.options !== void 0) {
            if (typeof params.options !== "object" || params.options === null || Array.isArray(params.options)) {
              return { success: false, error: '"options" must be an object (EventInit properties, e.g. {"detail": {...}, "cancelable": false})' };
            }
            options = params.options;
          }
          const init = { bubbles: true, cancelable: true, composed: true, ...options };
          if (event === "focus") {
            if (document.activeElement !== el) el.focus();
            else el.dispatchEvent(new Event("focus", init));
          } else if (event === "blur") {
            if (document.activeElement === el) el.blur();
            else el.dispatchEvent(new Event("blur", init));
          } else {
            el.dispatchEvent(constructTriggerEvent(event, init));
          }
          const stable = await waitForSettled(3e3);
          const waitForResult = params.waitFor ? await waitForCondition(params.waitFor, 3e3) : null;
          const triggerData = {
            selector,
            event,
            tag: el.tagName.toLowerCase(),
            ...valueApplied ? { value: params.value } : {},
            settledMs: stable.waited
          };
          if (waitForResult) triggerData.waitFor = waitForResult;
          return { success: true, data: triggerData };
        }
        case "get_text": {
          const selector = params.selector;
          const el = selector ? findElement(selector) : document.body;
          if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          return { success: true, data: el.textContent?.trim() };
        }
        case "get_css": {
          const selector = params.selector;
          if (!selector) return { success: false, error: "selector is required" };
          const isCss = selector.startsWith("css:");
          const query = isCss ? selector.slice(4) : selector;
          const nodes = isCss ? findAllPierced(query) : [findElement(selector)].filter(Boolean);
          if (nodes.length === 0) return { success: false, notFound: true, error: `Element not found: ${selector}` };
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
        case "frame_info": {
          return {
            success: true,
            data: {
              url: window.location.href,
              title: document.title,
              html: document.documentElement.outerHTML
            }
          };
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
        case "list_elements": {
          const known = ["frame", "filter", "text", "max", "visible"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown list_elements parameter(s): ${unknown.join(", ")} (expected frame, filter, text, max, visible)` };
          }
          const filters = typeof params.filter === "string" ? params.filter.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
          const textFilter = typeof params.text === "string" ? params.text.trim() : "";
          let max = typeof params.max === "number" && Number.isFinite(params.max) ? Math.max(1, Math.floor(params.max)) : 50;
          max = Math.min(max, 200);
          const visibleOnly = params.visible === true;
          const hiddenOnly = params.visible === false;
          const INTERACTIVE_SELECTOR = "button, a, select, textarea, input, label, [contenteditable], [tabindex], [role]";
          const INTERACTIVE_ROLES = /* @__PURE__ */ new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "combobox", "textbox", "listbox", "slider", "spinbutton", "searchbox"]);
          const candidates = [];
          const seen = /* @__PURE__ */ new Set();
          const consider = (el) => {
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
          const elements = [];
          for (const el of candidates) {
            const html = el;
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute("role")?.toLowerCase() ?? void 0;
            const type = el instanceof HTMLInputElement ? el.type : void 0;
            const text = (html.innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
            const visible = isVisible(html);
            if (visibleOnly && !visible) continue;
            if (hiddenOnly && visible) continue;
            if (textFilter && !text.includes(textFilter)) continue;
            if (filters.length > 0) {
              const hit = filters.some((f) => {
                switch (f) {
                  case "button":
                    return tag === "button" || role === "button";
                  case "link":
                    return tag === "a" || role === "link";
                  case "input":
                    return tag === "input";
                  case "select":
                    return tag === "select";
                  case "textarea":
                    return tag === "textarea";
                  case "label":
                    return tag === "label";
                  case "editable":
                    return html.isContentEditable || tag === "textarea" || tag === "input" && type !== void 0 && /text|search|email|url|tel|number|password|date|time|datetime-local|month|week/.test(type);
                  case "upload":
                    return tag === "input" && type === "file" || /点击上传|上传|拖入|拖拽|拖到|upload|drop/i.test(text);
                  default:
                    return true;
                }
              });
              if (!hit) continue;
            }
            const rect = el.getBoundingClientRect();
            const item = {
              tag,
              visible,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
              selector: genSelector(el)
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
            data: { count: truncated ? max : elements.length, truncated, elements: truncated ? elements.slice(0, max) : elements }
          };
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
            let timer;
            const cleanup = () => {
              document.removeEventListener("readystatechange", onChange);
              if (timer != null) clearTimeout(timer);
            };
            const onChange = () => {
              if (document.readyState === "complete") {
                settled = true;
                cleanup();
                waitForSettled(3e3).then(() => {
                  resolve({ success: true, data: { readyState: "complete", elapsed: Date.now() - start } });
                });
              }
            };
            document.addEventListener("readystatechange", onChange);
            if (document.readyState === "complete") {
              settled = true;
              cleanup();
              waitForSettled(3e3).then(() => {
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
          const known = ["x", "y", "selector", "block", "frame"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown scroll parameter(s): ${unknown.join(", ")} (expected x, y, selector, block)` };
          }
          const x = params.x ?? 0;
          const y = params.y ?? 0;
          const selector = params.selector;
          if (selector) {
            const el = findElement(selector);
            if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
            if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
              el.scrollTo({ top: y, left: x, behavior: "smooth" });
              await waitForSettled(3e3);
              return { success: true, data: { scrollTarget: "container", scrollX: el.scrollLeft, scrollY: el.scrollTop } };
            }
            const block = ["start", "center", "end", "nearest"].includes(params.block) ? params.block : "center";
            el.scrollIntoView({ behavior: "smooth", block });
            await waitForSettled(3e3);
            return { success: true, data: { scrollTarget: "element", scrolledIntoView: selector } };
          }
          window.scrollTo({ top: y, left: x, behavior: "smooth" });
          await waitForSettled(3e3);
          return { success: true, data: { scrollX: window.scrollX, scrollY: window.scrollY } };
        }
        // 内部命令（SW real_click 点击后调用；CLI 不可直接发——BLOCKED）：等影响落地
        case "wait_for_settle": {
          const timeout = params.timeout ?? 3e3;
          const stable = await waitForSettled(timeout);
          const waitForResult = params.wait_for ? await waitForCondition(params.wait_for, timeout) : null;
          return {
            success: true,
            data: {
              settled: stable.waited < timeout,
              settledMs: stable.waited,
              ...waitForResult ? { waitFor: waitForResult } : {}
            }
          };
        }
        default:
          return { success: false, error: `Unknown command: ${command}` };
      }
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
  function throttleSafeTimer(ms) {
    if (document.visibilityState !== "hidden") {
      let timer;
      const promise2 = new Promise((resolve) => {
        timer = window.setTimeout(resolve, ms);
      });
      return {
        promise: promise2,
        cancel: () => {
          if (timer != null) clearTimeout(timer);
        }
      };
    }
    let cancelled = false;
    const start = performance.now();
    const ch = new MessageChannel();
    const promise = new Promise((resolve) => {
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
      }
    };
  }
  function waitForSettled(maxWaitMs) {
    const QUIET_MS = 250;
    const ACTIVITY_WINDOW_MS = 600;
    const start = Date.now();
    return new Promise((resolve) => {
      let quiet;
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
          inQuiet = true;
          activity?.cancel();
          for (const sr of openShadowRootsDeep(document)) {
            try {
              domObserver?.observe(sr, { childList: true, subtree: true, attributes: true, characterData: true });
            } catch {
            }
          }
        }
        quiet?.cancel();
        quiet = throttleSafeTimer(QUIET_MS);
        quiet.promise.then(finish);
      };
      const activity = throttleSafeTimer(ACTIVITY_WINDOW_MS);
      activity.promise.then(() => {
        if (inQuiet) return;
        if (document.visibilityState !== "hidden") {
          finish();
          return;
        }
        const confirm = throttleSafeTimer(1e3);
        confirm.promise.then(() => {
          if (!inQuiet) finish();
        });
      });
      let domObserver;
      try {
        domObserver = new MutationObserver(() => onActivity());
        const observeRoot = (root) => {
          try {
            domObserver?.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
          } catch {
          }
        };
        observeRoot(document.body);
        for (const sr of openShadowRootsDeep(document)) observeRoot(sr);
      } catch {
      }
      let longtaskObserver;
      try {
        if (typeof PerformanceObserver !== "undefined") {
          longtaskObserver = new PerformanceObserver(() => onActivity());
          longtaskObserver.observe({ entryTypes: ["longtask"] });
        }
      } catch {
      }
      requestAnimationFrame(() => requestAnimationFrame(() => {
      }));
      setTimeout(finish, maxWaitMs);
    });
  }
  async function waitForCondition(waitFor, timeoutMs) {
    const start = Date.now();
    const check = () => {
      if (waitFor.text) return !!findByText(waitFor.text);
      if (waitFor.selector) {
        const el = findElement(waitFor.selector);
        return !!el && isVisible(el);
      }
      return false;
    };
    if (check()) return { settled: true, waited: 0 };
    while (Date.now() - start < timeoutMs) {
      await throttleSafeTimer(50).promise;
      if (check()) return { settled: true, waited: Date.now() - start };
    }
    return { settled: false, waited: timeoutMs };
  }
  function evalTextXPath(xpath, context) {
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
      const htmlEl = el;
      if (isVisible(htmlEl)) return htmlEl;
      el = result.iterateNext();
    }
    return null;
  }
  function findByText(text) {
    const q = xpathStr(text);
    const hidden = "self::script or self::style or self::noscript or self::template or self::head or self::title or self::meta or self::svg or self::path";
    const bodyXpath = [
      `//body//button[contains(normalize-space(.), ${q})]`,
      `//body//a[contains(normalize-space(.), ${q})]`,
      `//body//input[contains(@value, ${q})]`,
      `//body//*[not(${hidden})][contains(normalize-space(.), ${q}) and not(./*[not(${hidden})][contains(normalize-space(.), ${q})])]`
    ].join(" | ");
    const shadowXpath = bodyXpath.split("//body//").join("//");
    const hit = evalTextXPath(bodyXpath, document);
    if (hit) return hit;
    for (const sr of openShadowRootsDeep(document)) {
      const h = evalTextXPath(shadowXpath, sr);
      if (h) return h;
    }
    return null;
  }
  function isVisible(el) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function acceptMatches(accept, mime, filename) {
    const mimeLower = mime.toLowerCase();
    const mimeType = mimeLower.split("/")[0] ?? "";
    const ext = (filename.split(".").pop() ?? "").toLowerCase();
    return accept.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean).some((a) => {
      if (a.startsWith(".")) return `.${ext}` === a;
      if (a.endsWith("/*")) return mimeType === a.slice(0, -2);
      return a === mimeLower;
    });
  }
  function xpathStr(s) {
    if (!s.includes("'")) return `'${s}'`;
    if (!s.includes('"')) return `"${s}"`;
    return "concat('" + s.replace(/'/g, `',"'",'`) + "')";
  }
  var KEY_CODE_MAP = {
    Enter: 13,
    Escape: 27,
    Tab: 9,
    Backspace: 8,
    Delete: 46,
    Insert: 45,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    " ": 32,
    Space: 32,
    F1: 112,
    F2: 113,
    F3: 114,
    F4: 115,
    F5: 116,
    F6: 117,
    F7: 118,
    F8: 119,
    F9: 120,
    F10: 121,
    F11: 122,
    F12: 123
  };
  var MODIFIER_KEYS = /* @__PURE__ */ new Set(["Control", "Shift", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock"]);
  function keyboardEventInit(key, mods) {
    const single = key.length === 1;
    const keyCode = KEY_CODE_MAP[key] ?? (single ? key.toUpperCase().charCodeAt(0) : 0);
    const code = key === " " || key === "Space" ? "Space" : single ? /[0-9]/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}` : key;
    return { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, ...mods };
  }
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, String(value));
    else el.value = String(value);
  }
  function setNativeChecked(el, checked) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
    if (setter) setter.call(el, checked);
    else el.checked = checked;
  }
  function base64ToFile(base64, filename, mime) {
    const clean = base64.replace(/^data:[^;]+;base64,/, "");
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], filename, { type: mime });
  }
  function constructTriggerEvent(name, init) {
    if (name.startsWith("key")) return new KeyboardEvent(name, init);
    if (name.startsWith("mouse")) return new MouseEvent(name, init);
    return new CustomEvent(name, init);
  }
  function openShadowRootsDeep(root) {
    const out = [];
    const walk = (r) => {
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
  function hasShadowToken(sel) {
    let quote = null;
    let depth = 0;
    for (let i = 0; i < sel.length; i++) {
      const ch = sel[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "(" || ch === "[") {
        depth++;
        continue;
      }
      if (ch === ")" || ch === "]") {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth > 0) continue;
      if (ch === ">" && sel[i + 1] === ">" && sel[i + 2] === ">") return true;
      if (ch === "#" && sel.startsWith("shadow-root", i + 1)) {
        const after = sel[i + 1 + "shadow-root".length];
        if (after === void 0 || !/[a-zA-Z0-9_-]/.test(after)) return true;
      }
    }
    return false;
  }
  function tokenizeShadowPath(sel) {
    const tokens = [];
    let quote = null;
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
      if (ch === "'" || ch === '"') {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === "(" || ch === "[") {
        depth++;
        cur += ch;
        continue;
      }
      if (ch === ")" || ch === "]") {
        depth = Math.max(0, depth - 1);
        cur += ch;
        continue;
      }
      if (depth > 0) {
        cur += ch;
        continue;
      }
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
        if (after === void 0 || !/[a-zA-Z0-9_-]/.test(after)) {
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
  function matchCssSegment(segment, contexts) {
    const out = [];
    for (const ctx of contexts) {
      try {
        for (const el of Array.from(ctx.querySelectorAll(segment))) out.push(el);
      } catch {
      }
    }
    if (out.length > 0) return out;
    for (const ctx of contexts) {
      for (const sr of openShadowRootsDeep(ctx)) {
        try {
          for (const el of Array.from(sr.querySelectorAll(segment))) out.push(el);
        } catch {
        }
      }
    }
    return out;
  }
  function walkShadowPath(sel) {
    const tokens = tokenizeShadowPath(sel);
    let cands = [];
    for (const tok of tokens) {
      if (tok.kind === "css") {
        const contexts = cands.length > 0 ? cands : [document];
        cands = Array.from(new Set(matchCssSegment(tok.value, contexts)));
        if (cands.length === 0) return [];
      } else if (tok.kind === "shadowroot") {
        cands = cands.filter((c) => c instanceof Element && !!c.shadowRoot).map((c) => c.shadowRoot);
        if (cands.length === 0) return [];
      } else {
        const next = [];
        for (const c of cands) {
          for (const sr of openShadowRootsDeep(c)) next.push(sr);
        }
        cands = Array.from(new Set(next));
        if (cands.length === 0) return [];
      }
    }
    return cands;
  }
  function findCssPierced(css) {
    if (hasShadowToken(css)) {
      const hit = walkShadowPath(css).find((c) => c instanceof Element);
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
  function findAllPierced(selector) {
    const css = selector.startsWith("css:") ? selector.slice(4) : selector;
    if (hasShadowToken(css)) {
      return walkShadowPath(css).filter((c) => c instanceof Element);
    }
    const direct = Array.from(document.querySelectorAll(css));
    if (direct.length > 0) return direct;
    const out = [];
    for (const sr of openShadowRootsDeep(document)) {
      for (const el of Array.from(sr.querySelectorAll(css))) out.push(el);
    }
    return out;
  }
  function findXPathPierced(xpath) {
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const direct = result.singleNodeValue;
    if (direct) return direct;
    for (const sr of openShadowRootsDeep(document)) {
      for (const child of Array.from(sr.children)) {
        try {
          const r = document.evaluate(xpath, child, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const hit = r.singleNodeValue;
          if (hit) return hit;
        } catch {
        }
      }
    }
    return null;
  }
  function findElement(selector) {
    if (selector.startsWith("css:")) {
      return findCssPierced(selector.slice(4));
    }
    if (selector.startsWith("xpath:")) {
      return findXPathPierced(selector.slice(6));
    }
    return findCssPierced(selector);
  }
  function genSelector(el) {
    const esc = (s) => CSS.escape(s);
    const nthOfType = (e) => {
      let n = 1;
      for (let sib = e.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === e.tagName) n++;
      }
      return n;
    };
    const segs = [];
    let cur = el;
    let lastCross = false;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      let seg;
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) {
        seg = `#${esc(cur.id)}`;
        if (segs.length > 0) segs[0].cross = lastCross;
        segs.unshift({ seg, cross: false });
        break;
      } else {
        const cls = Array.from(cur.classList).filter((c) => /^[a-zA-Z_][\w-]*$/.test(c)).slice(0, 2);
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
      if (i > 0) out += segs[i - 1].cross ? " >>> " : " > ";
      out += segs[i].seg;
    }
    return out || el.tagName.toLowerCase();
  }
  chrome.runtime.sendMessage({ type: "cs_injected" }).catch(() => {
  });
})();
