"use strict";
(() => {
  // src/content/content-script.ts
  var jsErrors = [];
  var MAX_JS_ERRORS = 200;
  function pushJsError(e) {
    jsErrors.push(e);
    if (jsErrors.length > MAX_JS_ERRORS) jsErrors.splice(0, jsErrors.length - MAX_JS_ERRORS);
  }
  function onPageError(ev) {
    pushJsError({ message: ev.message, source: ev.filename, lineno: ev.lineno, colno: ev.colno });
  }
  function onUnhandledRejection(ev) {
    const reason = ev.reason;
    const msg = typeof reason === "string" ? reason : reason?.message ?? String(reason);
    pushJsError({ message: `Unhandled rejection: ${msg}`, source: "unhandledrejection" });
  }
  window.addEventListener("error", onPageError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  var MAIN_ERROR_EVT = "__cda_js_error__";
  var MAIN_ERROR_SYNC_EVT = "__cda_js_error_sync__";
  function onMainWorldError(ev) {
    if (!(ev instanceof CustomEvent)) return;
    const d = ev.detail;
    if (!d || typeof d.message !== "string" || typeof d.source !== "string") return;
    pushJsError({
      message: d.message,
      source: d.source,
      ...typeof d.lineno === "number" ? { lineno: d.lineno } : {},
      ...typeof d.colno === "number" ? { colno: d.colno } : {}
    });
  }
  document.addEventListener(MAIN_ERROR_EVT, onMainWorldError);
  try {
    document.dispatchEvent(new CustomEvent(MAIN_ERROR_SYNC_EVT));
  } catch {
  }
  var MAIN_ACTION_EVT = "__cda_main_action__";
  var MAIN_ACTION_REPLY_EVT = "__cda_main_action_reply__";
  var mainPending = /* @__PURE__ */ new Map();
  var mainSeq = 0;
  function onMainActionReply(detail) {
    const d = detail;
    if (!d || typeof d !== "object" || typeof d.requestId !== "number") return;
    const p = mainPending.get(d.requestId);
    if (!p) return;
    mainPending.delete(d.requestId);
    window.clearTimeout(p.timer);
    const { requestId, ...rest } = d;
    p.resolve({ ...rest, ok: rest.ok === true });
  }
  document.addEventListener(
    MAIN_ACTION_REPLY_EVT,
    (ev) => onMainActionReply(ev.detail)
  );
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m && typeof m === "object" && m.__cdaMain === MAIN_ACTION_REPLY_EVT) {
      onMainActionReply(m.detail);
    }
  });
  function requestMainWorld(action, params, timeoutMs = 500) {
    const requestId = ++mainSeq;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        mainPending.delete(requestId);
        resolve({ ok: false, error: "\u4E3B\u4E16\u754C\u65E0\u5E94\u7B54\uFF08\u4E3B\u4E16\u754C\u811A\u672C\u672A\u6CE8\u5165\u6216\u6267\u884C\u5F02\u5E38\uFF09" });
      }, timeoutMs);
      mainPending.set(requestId, { resolve, timer });
      const detail = { requestId, action, ...params };
      try {
        document.dispatchEvent(new CustomEvent(MAIN_ACTION_EVT, { detail }));
      } catch {
      }
      try {
        window.postMessage({ __cdaMain: MAIN_ACTION_EVT, detail }, "*");
      } catch {
      }
    });
  }
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
  function rawTextOf(el) {
    return el.textContent || "";
  }
  function collapseWs(s) {
    return s.trim().replace(/\s+/g, " ");
  }
  function textMatches(haystack, needle) {
    if (!needle) return true;
    if (haystack.includes(needle)) return true;
    return collapseWs(haystack).includes(collapseWs(needle));
  }
  function describeLayer(top) {
    const htmlTop = top;
    const desc = { tag: top.tagName.toLowerCase() };
    const cls = Array.from(htmlTop.classList).slice(0, 3).join(".");
    if (cls) desc.class = cls;
    const txt = rawTextOf(htmlTop);
    if (txt) desc.text = txt;
    return desc;
  }
  async function handleCommand(payload) {
    const { command, params = {} } = payload;
    const fields = getFieldFilter(params);
    try {
      switch (command) {
        case "click": {
          const known = ["text", "selector", "x", "y", "frame", "waitFor", "exact"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown click parameter(s): ${unknown.join(", ")} (expected text, selector, x, y, waitFor, exact)` };
          }
          if (params.exact !== void 0 && typeof params.exact !== "boolean") {
            return { success: false, error: `"exact" must be a boolean (got ${JSON.stringify(params.exact)})` };
          }
          if (params.x !== void 0 && typeof params.x !== "number") {
            return { success: false, error: `"x" must be a number (got ${JSON.stringify(params.x)})` };
          }
          if (params.y !== void 0 && typeof params.y !== "number") {
            return { success: false, error: `"y" must be a number (got ${JSON.stringify(params.y)})` };
          }
          let el;
          let clickDesc = {};
          const dispatchFullClick = (target, x, y) => {
            if (x === void 0 || y === void 0) {
              target.scrollIntoView({ block: "center", behavior: "instant" });
            }
            const rect = target.getBoundingClientRect();
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
          const coverageReport = (target, cx, cy) => {
            const htmlEl = target;
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
          if (params.text) {
            const text = params.text;
            const found = findByText(text, params.exact === true);
            if (!found) return { success: false, notFound: true, error: `No element found with text: ${text}` };
            el = found;
            const { cx, cy } = dispatchFullClick(el);
            clickDesc = { text, tag: el.tagName.toLowerCase(), ...coverageReport(el, cx, cy) };
          } else if (params.x !== void 0 && params.y !== void 0) {
            const x = params.x;
            const y = params.y;
            const found = document.elementFromPoint(x, y);
            if (!found) return { success: false, notFound: true, error: `No element at (${x}, ${y})` };
            el = found;
            dispatchFullClick(el, x, y);
            clickDesc = { x, y, tag: el.tagName.toLowerCase() };
          } else {
            const selector = params.selector;
            if (!selector) return { success: false, error: "Need text, selector, or {x,y}" };
            const found = findElement(selector);
            if (!found) return { success: false, notFound: true, error: `Element not found: ${selector}` };
            el = found;
            const { cx, cy } = dispatchFullClick(el);
            clickDesc = { selector, tag: el.tagName.toLowerCase(), ...coverageReport(el, cx, cy) };
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
        case "get_prop": {
          const known = ["selector", "text", "prop", "frame", "exact"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown get_prop parameter(s): ${unknown.join(", ")} (expected selector, text, prop, frame, exact)` };
          }
          if (params.exact !== void 0 && typeof params.exact !== "boolean") {
            return { success: false, error: `"exact" must be a boolean (got ${JSON.stringify(params.exact)})` };
          }
          const prop = params.prop;
          if (typeof prop !== "string" || !prop) {
            return { success: false, error: 'Need "prop" parameter (e.g. "innerHTML", "value", "checked")' };
          }
          for (const k of ["selector", "text"]) {
            const v = params[k];
            if (v !== void 0 && typeof v !== "string") {
              return { success: false, error: `"${k}" must be a string (got ${JSON.stringify(v)})` };
            }
          }
          if (params.selector === void 0 && params.text === void 0) {
            return { success: false, error: 'Need "selector" or "text" parameter' };
          }
          const el = params.text ? findByText(params.text, params.exact === true) : findElement(params.selector);
          if (!el) return { success: false, notFound: true, error: `Element not found: ${params.text ?? params.selector}` };
          const tag = el.tagName.toLowerCase();
          if (!(prop in el)) {
            return {
              success: false,
              error: `No property "${prop}" on <${tag}> \u2014 examples: "innerHTML", "textContent", "value", "className", "checked", "id", "src", "href", "dataset"`
            };
          }
          const val = el[prop];
          if (typeof val === "function") {
            return { success: false, error: `"${prop}" is a method on <${tag}> \u2014 get_prop only reads properties, it never calls methods` };
          }
          if (val === void 0) {
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
          const known = ["selector", "text", "frame", "scroll", "all", "waitStableMs", "exact"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown get_rect parameter(s): ${unknown.join(", ")} (expected selector, text, exact, all, waitStableMs, scroll)` };
          }
          const selector = params.selector;
          if (!selector && !params.text) return { success: false, error: 'Need "selector" or "text" parameter' };
          if (params.exact !== void 0 && typeof params.exact !== "boolean") {
            return { success: false, error: `"exact" must be a boolean (got ${JSON.stringify(params.exact)})` };
          }
          if (params.all !== void 0 && typeof params.all !== "boolean") {
            return { success: false, error: `"all" must be a boolean (got ${JSON.stringify(params.all)})` };
          }
          if (params.waitStableMs !== void 0 && (typeof params.waitStableMs !== "number" || params.waitStableMs < 0)) {
            return { success: false, error: `"waitStableMs" must be a non-negative number (got ${JSON.stringify(params.waitStableMs)})` };
          }
          const exact = params.exact === true;
          const el = params.text ? findByText(params.text, exact) : findElement(selector);
          if (!el) return { success: false, notFound: true, error: `Element not found: ${params.text || selector}` };
          if (params.scroll === true) {
            el.scrollIntoView({ block: "center", behavior: "instant" });
          }
          let stable = null;
          if (typeof params.waitStableMs === "number" && params.waitStableMs > 0) {
            const started = Date.now();
            let last = el.getBoundingClientRect();
            let unchangedSince = started;
            const deadline = started + params.waitStableMs + 5e3;
            stable = { waited: 0, stable: false };
            while (Date.now() < deadline) {
              await throttleSafeTimer(50).promise;
              const now = el.getBoundingClientRect();
              if (now.left !== last.left || now.top !== last.top || now.width !== last.width || now.height !== last.height) {
                last = now;
                unchangedSince = Date.now();
                continue;
              }
              if (Date.now() - unchangedSince >= params.waitStableMs) {
                stable = { waited: Date.now() - started, stable: true };
                break;
              }
            }
            if (!stable.stable) stable.waited = Date.now() - started;
          }
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
          const rectCss = crossOrigin ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : { x: rect.left + (x - lx), y: rect.top + (y - ly), w: rect.width, h: rect.height };
          const centerCss = { x: rectCss.x + rectCss.w / 2, y: rectCss.y + rectCss.h / 2 };
          const hostChain = [];
          for (let n = el; n; ) {
            const root = n.getRootNode();
            if (root instanceof ShadowRoot) {
              hostChain.push(root.host);
              n = root.host;
            } else break;
          }
          const top = document.elementFromPoint(lx, ly);
          const hitTest = top ? { ...describeLayer(top), ...hostChain.length ? { shadowRetargeted: true } : {} } : null;
          const covered = !!top && top !== el && !el.contains(top) && !hostChain.some((h) => h === top || h.contains(top));
          const allMatches = [];
          let matchCount = 1;
          let truncated = false;
          if (params.text) {
            const candidates = findAllByText(params.text, exact);
            matchCount = candidates.length;
            if (params.all === true || matchCount > 1) {
              const limit = params.all === true ? 100 : 20;
              let priority = 0;
              for (const cand of candidates) {
                if (allMatches.length >= limit) {
                  truncated = true;
                  break;
                }
                const hEl = cand;
                const vis = isVisible(hEl);
                const r = hEl.getBoundingClientRect();
                allMatches.push({
                  tag: cand.tagName.toLowerCase(),
                  class: Array.from(hEl.classList).slice(0, 3).join("."),
                  text: rawTextOf(hEl),
                  rectCss: { x: r.left, y: r.top, w: r.width, h: r.height },
                  visible: vis,
                  // priority 只在可见候选间计数：0 = click {text} 会点的那个。
                  // 不可见的候选点不到，因此不给 priority（不是 0，也不是被跳过）
                  ...vis ? { priority: priority++ } : {}
                });
              }
            }
          }
          return {
            success: true,
            data: {
              selector,
              x: Math.round(x),
              y: Math.round(y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              ...crossOrigin ? { crossOrigin: true, localX: Math.round(lx), localY: Math.round(ly) } : {},
              // 以下为增补字段（既有字段语义与取值未变：x/y = Math.round(centerCss)）
              rectCss,
              centerCss,
              tag: el.tagName.toLowerCase(),
              class: Array.from(el.classList).slice(0, 3).join("."),
              text: rawTextOf(el),
              visible: isVisible(el),
              covered,
              hitTest,
              matchCount,
              ...allMatches.length ? { allMatches } : {},
              ...truncated ? { truncated: true } : {},
              ...stable ? { waitStable: stable } : {}
            }
          };
        }
        case "get_viewport": {
          const known = ["frame"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown get_viewport parameter(s): ${unknown.join(", ")} (expected no parameters)` };
          }
          const vv = window.visualViewport;
          return {
            success: true,
            data: {
              viewportCss: { w: window.innerWidth, h: window.innerHeight },
              scrollCss: {
                x: Math.round(window.scrollX),
                y: Math.round(window.scrollY)
              },
              dpr: window.devicePixelRatio,
              screenCss: { w: window.screen.width, h: window.screen.height },
              devicePixelRatio: window.devicePixelRatio,
              isTop: window === window.top,
              url: location.href,
              ...vv ? { visualViewportCss: { w: vv.width, h: vv.height, scale: vv.scale, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop } } : {}
            }
          };
        }
        case "show": {
          const known = ["selector", "frame"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown show parameter(s): ${unknown.join(", ")} (expected selector)` };
          }
          const selector = params.selector;
          if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
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
          const known = [];
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
          const selector = params.selector;
          const text = params.text;
          const mode = params.mode || "replace";
          if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
          if (typeof text !== "string") return { success: false, error: 'Need "text" parameter (a string)' };
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
            document.execCommand("insertText", false, text);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const stable = await waitForSettled(3e3);
          const waitForResult = params.waitFor ? await waitForCondition(params.waitFor, 3e3) : null;
          const typeData = { selector, mode, tag: el.tagName.toLowerCase(), settledMs: stable.waited };
          if (waitForResult) typeData.waitFor = waitForResult;
          return { success: true, data: typeData };
        }
        case "keyboard": {
          const known = ["selector", "key", "ctrl", "shift", "alt", "meta", "frame", "waitFor"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown keyboard parameter(s): ${unknown.join(", ")} (expected selector, key, ctrl, shift, alt, meta, waitFor)` };
          }
          for (const mod of ["ctrl", "shift", "alt", "meta"]) {
            const v = params[mod];
            if (v !== void 0 && typeof v !== "boolean") {
              return { success: false, error: `"${mod}" must be true or false (got ${JSON.stringify(v)})` };
            }
          }
          const key = params.key;
          if (typeof key !== "string" || !key) return { success: false, error: 'Need "key" parameter (a string, e.g. Enter, Escape, Tab, ArrowDown, "a")' };
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
          const known = ["selector", "base64", "filename", "mime", "frame", "waitFor"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown upload_file parameter(s): ${unknown.join(", ")} (expected selector, base64, filename, mime, waitFor)` };
          }
          const selector = params.selector;
          const base64 = params.base64;
          const filename = params.filename;
          const mime = params.mime;
          if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
          if (typeof base64 !== "string" || !base64) return { success: false, error: 'Need "base64" parameter (a string)' };
          if (typeof filename !== "string" || !filename) return { success: false, error: 'Need "filename" parameter (e.g. "a.jpg")' };
          if (typeof mime !== "string" || !mime) return { success: false, error: 'Need "mime" parameter (e.g. "image/jpeg")' };
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
          if (data.base64 !== void 0 === (data.url !== void 0)) {
            return { success: false, error: '"data" must have exactly one of "base64" or "url"' };
          }
          const el = findElement(selector);
          if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          let file;
          if (data.base64 !== void 0) {
            const filename = data.filename;
            const mime = data.mime;
            if (typeof filename !== "string" || !filename) {
              return { success: false, error: '"data" needs "filename" (e.g. "a.jpg") when using base64 \u2014 no silent default file name' };
            }
            if (typeof mime !== "string" || !mime) {
              return { success: false, error: '"data" needs "mime" (e.g. "image/jpeg") when using base64 \u2014 no silent default type' };
            }
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
              const derived = url.split(/[?#]/)[0].split("/").pop() || "";
              const name = data.filename || derived;
              if (!name) {
                return { success: false, error: 'Could not derive a file name from the URL path (e.g. redirect targets) \u2014 pass "data.filename" explicitly' };
              }
              file = new File([blob], name, { type: blob.type || "application/octet-stream" });
            } catch (e) {
              return { success: false, error: `Failed to fetch url: ${url} (${e.message})` };
            }
          }
          const dt = new DataTransfer();
          dt.items.add(file);
          for (const type of ["dragenter", "dragover", "drop", "dragleave"]) {
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
          const known = ["selector", "html", "mode", "frame", "waitFor"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown paste_rich parameter(s): ${unknown.join(", ")} (expected selector, html, mode, waitFor)` };
          }
          const selector = params.selector;
          const html = params.html;
          const mode = params.mode || "replace";
          if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
          if (typeof html !== "string" || !html) return { success: false, error: 'Need "html" parameter (a string)' };
          if (mode !== "replace" && mode !== "append" && mode !== "insert") {
            return { success: false, error: `Invalid mode: ${mode} (expected replace|append|insert)` };
          }
          const el = findElement(selector);
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
              const anchor = sel.anchorNode;
              if (!(anchor instanceof Node) || !el.contains(anchor)) {
                range.selectNodeContents(el);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }
          }
          const before = (el.textContent || "").length;
          const pasteResult = await requestMainWorld("paste_dispatch", { html });
          await waitForSettled(3e3);
          const changed = el.textContent !== null && el.textContent.length !== before;
          let pipeline;
          if (pasteResult.ok && pasteResult.defaultPrevented) {
            pipeline = "editor_paste";
          } else if (changed) {
            pipeline = "default_paste";
          } else {
            pipeline = "insertHTML_fallback";
            document.execCommand("insertHTML", false, html);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const stable = await waitForSettled(3e3);
          const waitForResult = params.waitFor ? await waitForCondition(params.waitFor, 3e3) : null;
          const pasteData = {
            selector,
            mode,
            pipeline,
            // editor_paste=编辑器接管（走自身粘贴管线）；insertHTML_fallback=无人接管 DOM 直插
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
          if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
          if (typeof event !== "string" || !event) {
            return { success: false, error: 'Need "event" parameter (a string, e.g. "change", "blur", "focus", "input", "select", or a custom event name)' };
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
          const known = ["selector", "frame"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown get_text parameter(s): ${unknown.join(", ")} (expected selector)` };
          }
          const selector = params.selector;
          if (selector !== void 0 && typeof selector !== "string") {
            return { success: false, error: `"selector" must be a string (got ${JSON.stringify(selector)})` };
          }
          const el = selector ? findElement(selector) : document.body;
          if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          return { success: true, data: el.textContent ?? "" };
        }
        case "set_cursor": {
          const known = ["selector", "text", "occurrence", "position", "frame", "waitFor"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown set_cursor parameter(s): ${unknown.join(", ")} (expected selector, text, occurrence, position, waitFor)` };
          }
          const selector = params.selector;
          const text = params.text;
          const occurrence = params.occurrence === void 0 ? 1 : params.occurrence;
          const position = params.position === void 0 ? "after" : params.position;
          if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
          if (typeof text !== "string" || !text) return { success: false, error: 'Need "text" parameter (a string)' };
          if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 1) {
            return { success: false, error: `"occurrence" must be a positive integer (got ${JSON.stringify(params.occurrence)})` };
          }
          if (position !== "before" && position !== "after" && position !== "start" && position !== "end") {
            return { success: false, error: `Invalid position: ${JSON.stringify(params.position)} (expected before|after|start|end)` };
          }
          const el = findElement(selector);
          if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          if (!el.isContentEditable) {
            return { success: false, error: `Element is not contenteditable: ${selector} (tag=${el.tagName})` };
          }
          const placed = await requestMainWorld("caret_set", { selector, text, occurrence, position });
          if (!placed.ok) {
            return { success: false, error: typeof placed.error === "string" ? placed.error : "caret_set failed" };
          }
          const stable = await waitForSettled(3e3);
          const waitForResult = params.waitFor ? await waitForCondition(params.waitFor, 3e3) : null;
          const readback = await requestMainWorld("caret_get", { selector });
          if (!readback.ok) {
            return { success: false, error: typeof readback.error === "string" ? readback.error : "caret_get failed" };
          }
          if (readback.inEditor !== true) {
            return { success: false, error: "\u5149\u6807\u672A\u88AB\u7F16\u8F91\u5668\u4FDD\u6301\uFF1A\u843D\u70B9\u540E\u5149\u6807\u4E0D\u5728\u7F16\u8F91\u5668\u5185\uFF08\u7126\u70B9\u88AB\u62D2\u6216\u9009\u533A\u88AB\u9875\u9762\u63A5\u7BA1\uFF09" };
          }
          const cursorData = {
            selector,
            position,
            // 请求的相对位置（落点是否被编辑器归整看 row/col）
            row: readback.row,
            // 0 基行号：编辑器归整后的实际光标所在行
            col: readback.col,
            // 行内 JS UTF-16 偏移（可直接对下方 text 做 slice(0,col) 对账）
            text: readback.text,
            // 光标所在行逻辑全文（含定位目标的上下文）
            settledMs: stable.waited
          };
          if (waitForResult) cursorData.waitFor = waitForResult;
          return { success: true, data: cursorData };
        }
        case "get_cursor": {
          const known = ["selector", "frame"];
          const unknown = Object.keys(params).filter((k) => !k.startsWith("_") && !known.includes(k));
          if (unknown.length) {
            return { success: false, error: `Unknown get_cursor parameter(s): ${unknown.join(", ")} (expected selector)` };
          }
          const selector = params.selector;
          if (typeof selector !== "string" || !selector) return { success: false, error: 'Need "selector" parameter (a string)' };
          const el = findElement(selector);
          if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
          if (!el.isContentEditable) {
            return { success: false, error: `Element is not contenteditable: ${selector} (tag=${el.tagName})` };
          }
          const read = await requestMainWorld("caret_get", { selector });
          if (!read.ok) {
            return { success: false, error: typeof read.error === "string" ? read.error : "caret_get failed" };
          }
          return {
            success: true,
            data: {
              selector,
              inEditor: read.inEditor === true,
              // 光标是否在该编辑器内；false 时下方三项为 null
              row: read.row,
              // 0 基行号
              col: read.col,
              // 行内 JS UTF-16 偏移
              text: read.text
              // 光标所在行逻辑全文
            }
          };
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
          if (params.filter !== void 0 && typeof params.filter !== "string") {
            return { success: false, error: '"filter" must be a comma-separated string (button|link|input|select|textarea|label|editable|upload)' };
          }
          if (params.text !== void 0 && typeof params.text !== "string") {
            return { success: false, error: '"text" must be a string (substring match on element text)' };
          }
          if (params.visible !== void 0 && typeof params.visible !== "boolean") {
            return { success: false, error: '"visible" must be true (visible only) or false (hidden only)' };
          }
          if (params.max !== void 0 && (typeof params.max !== "number" || !Number.isFinite(params.max))) {
            return { success: false, error: '"max" must be a number (1-200)' };
          }
          const VALID_FILTERS = /* @__PURE__ */ new Set(["button", "link", "input", "select", "textarea", "label", "editable", "upload"]);
          const filters = params.filter ? params.filter.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
          for (const f of filters) {
            if (!VALID_FILTERS.has(f)) {
              return { success: false, error: `Unknown list_elements filter: "${f}" (expected button|link|input|select|textarea|label|editable|upload)` };
            }
          }
          const textFilter = typeof params.text === "string" ? params.text : "";
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
            const text = rawTextOf(html);
            const visible = isVisible(html);
            if (visibleOnly && !visible) continue;
            if (hiddenOnly && visible) continue;
            if (!textMatches(text, textFilter)) continue;
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
          const all = [...jsErrors];
          return { success: true, data: { errors: all, count: all.length } };
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
          for (const c of ["x", "y"]) {
            const v = params[c];
            if (v !== void 0 && typeof v !== "number") {
              return { success: false, error: `"${c}" must be a number (got ${JSON.stringify(v)})` };
            }
          }
          if (params.block !== void 0) {
            if (typeof params.block !== "string" || !["start", "center", "end", "nearest"].includes(params.block)) {
              return { success: false, error: `Invalid block: ${JSON.stringify(params.block)} (expected start|center|end|nearest)` };
            }
          }
          const x = params.x ?? 0;
          const y = params.y ?? 0;
          const selector = params.selector;
          if (selector) {
            const el = findElement(selector);
            if (!el) return { success: false, notFound: true, error: `Element not found: ${selector}` };
            if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
              el.scrollTo({ top: y, left: x, behavior: "instant" });
              await waitForSettled(3e3);
              return { success: true, data: { scrollTarget: "container", scrollX: el.scrollLeft, scrollY: el.scrollTop } };
            }
            const block = ["start", "center", "end", "nearest"].includes(params.block) ? params.block : "center";
            el.scrollIntoView({ behavior: "instant", block });
            await waitForSettled(3e3);
            return { success: true, data: { scrollTarget: "element", scrolledIntoView: selector } };
          }
          window.scrollTo({ top: y, left: x, behavior: "instant" });
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
      const detail = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Unexpected error while running "${command}": ${detail} (please report this to cda)` };
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
    const ACTIVITY_WINDOW_MS = 1e3;
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
        if (document.body) observeRoot(document.body);
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
    const extra = Object.keys(waitFor).filter((k) => k !== "selector" && k !== "text");
    if (extra.length > 0) throw new Error(`Invalid waitFor key(s): ${extra.join(", ")} (expected "selector" or "text")`);
    if (waitFor.selector === void 0 && waitFor.text === void 0) {
      throw new Error('waitFor: provide "selector" or "text"');
    }
    if (waitFor.selector !== void 0 && waitFor.text !== void 0) {
      throw new Error('waitFor: provide "selector" or "text", not both');
    }
    if (waitFor.selector !== void 0 && typeof waitFor.selector !== "string") {
      throw new Error("waitFor.selector must be a string");
    }
    if (waitFor.text !== void 0 && typeof waitFor.text !== "string") {
      throw new Error("waitFor.text must be a string");
    }
    const start = Date.now();
    const check = () => {
      if (waitFor.text) return !!findByText(waitFor.text);
      const el = findElement(waitFor.selector);
      return !!el && isVisible(el);
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
  function buildTextXPath(text, exact) {
    const q = xpathStr(text);
    const qFlat = xpathStr(collapseWs(text));
    const hidden = "self::script or self::style or self::noscript or self::template or self::head or self::title or self::meta or self::svg or self::path";
    const cond = exact ? `(normalize-space(.) = ${qFlat} or . = ${q})` : `(contains(normalize-space(.), ${qFlat}) or contains(., ${q}))`;
    const valCond = exact ? `(@value = ${q} or @value = ${qFlat})` : `(contains(@value, ${q}) or contains(@value, ${qFlat}))`;
    const bodyXpath = [
      `//body//button[${cond}]`,
      `//body//a[${cond}]`,
      `//body//input[${valCond}]`,
      `//body//*[not(${hidden})][${cond} and not(./*[not(${hidden})][${cond}])]`
    ].join(" | ");
    return { bodyXpath, shadowXpath: bodyXpath.split("//body//").join("//") };
  }
  function findByText(text, exact = false) {
    const { bodyXpath, shadowXpath } = buildTextXPath(text, exact);
    const hit = evalTextXPath(bodyXpath, document);
    if (hit) return hit;
    for (const sr of openShadowRootsDeep(document)) {
      const h = evalTextXPath(shadowXpath, sr);
      if (h) return h;
    }
    return null;
  }
  function evalTextXPathAll(xpath, context) {
    if (context instanceof ShadowRoot) {
      const out2 = [];
      for (const child of Array.from(context.children)) out2.push(...evalTextXPathAll(xpath, child));
      return out2;
    }
    const result = document.evaluate(xpath, context, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    const out = [];
    let el = result.iterateNext();
    while (el) {
      out.push(el);
      el = result.iterateNext();
    }
    return out;
  }
  function findAllByText(text, exact) {
    const { bodyXpath, shadowXpath } = buildTextXPath(text, exact);
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    const push = (els) => {
      for (const el of els) {
        if (seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
    };
    push(evalTextXPathAll(bodyXpath, document));
    for (const sr of openShadowRootsDeep(document)) {
      push(evalTextXPathAll(shadowXpath, sr));
    }
    return out;
  }
  function nonJsonableReason(val, seen = /* @__PURE__ */ new Set()) {
    if (typeof val === "function") return "is a function \u2014 JSON cannot carry it";
    if (val === null || typeof val !== "object") return null;
    if (seen.has(val)) return "contains a circular reference \u2014 JSON cannot carry it";
    seen.add(val);
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item === void 0) return "contains an undefined element \u2014 JSON cannot carry it";
        const reason = nonJsonableReason(item, seen);
        if (reason) return reason;
      }
      seen.delete(val);
      return null;
    }
    const proto = Object.getPrototypeOf(val);
    if (proto !== Object.prototype && proto !== null) {
      return `holds a ${val.constructor?.name || "non-plain"} object \u2014 only plain data can be returned; read a string/number property like "innerHTML" or "value" instead`;
    }
    if (Object.getOwnPropertyNames(val).length !== Object.keys(val).length) {
      return `holds a ${val.constructor?.name || "non-plain"} object \u2014 only plain data can be returned; read a string/number property like "innerHTML" or "value" instead`;
    }
    for (const key of Object.keys(val)) {
      const item = val[key];
      if (item === void 0) return `contains an undefined value under "${key}" \u2014 JSON cannot carry it`;
      const reason = nonJsonableReason(item, seen);
      if (reason) return reason;
    }
    seen.delete(val);
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
  function genSelector(el, rootDoc = document) {
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
    while (cur && cur !== rootDoc.body && cur !== rootDoc.documentElement) {
      let seg;
      if (cur.id && rootDoc.querySelectorAll(`#${esc(cur.id)}`).length === 1) {
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
      if (i > 0) out += segs[i].cross ? " >>> " : " > ";
      out += segs[i].seg;
    }
    return out || el.tagName.toLowerCase();
  }
  chrome.runtime.sendMessage({ type: "cs_injected" }).catch(() => {
  });
  var __cdaDebugBridge = {
    handleCommand,
    genSelector
  };
  window.__cdaDebug = __cdaDebugBridge;
})();
