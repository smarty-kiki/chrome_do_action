"use strict";
(() => {
  // src/ws/client.ts
  var DEFAULT_OPTIONS = {
    maxRetries: 3,
    retryIntervalMs: 15e3
  };
  var WsClient = class {
    constructor(options) {
      this.ws = null;
      this.status = "disconnected";
      this.listeners = [];
      this.messageHandlers = /* @__PURE__ */ new Map();
      this.retryCount = 0;
      this.retryTimer = null;
      this.pingTimer = null;
      this.serverUrl = "";
      this.nodeName = "";
      this.nextRetryAt = null;
      this.connecting = false;
      this.reconnectOptions = { ...DEFAULT_OPTIONS, ...options };
    }
    getStatus() {
      return this.status;
    }
    getRetryState() {
      return {
        retryCount: this.retryCount,
        maxRetries: this.reconnectOptions.maxRetries,
        retryIntervalMs: this.reconnectOptions.retryIntervalMs,
        nextRetryAt: this.nextRetryAt
      };
    }
    connect(serverUrl, nodeName) {
      this.serverUrl = serverUrl;
      this.nodeName = nodeName;
      if (this.status === "connected" || this.connecting) {
        return;
      }
      this.cancelRetry();
      this.connecting = true;
      this.retryCount = 0;
      this.setStatus("connecting");
      this.doConnect();
    }
    disconnect() {
      this.cancelRetry();
      this.cancelPing();
      this.connecting = false;
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      }
      this.setStatus("disconnected");
    }
    send(msg) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    }
    onMessage(type, handler) {
      if (!this.messageHandlers.has(type)) {
        this.messageHandlers.set(type, /* @__PURE__ */ new Set());
      }
      this.messageHandlers.get(type).add(handler);
      return () => this.messageHandlers.get(type)?.delete(handler);
    }
    onStatusChange(listener) {
      this.listeners.push(listener);
      listener(this.status);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
    }
    doConnect() {
      if (!this.isValidUrl(this.serverUrl)) {
        this.onConnectFailed();
        return;
      }
      try {
        const ws = new WebSocket(this.serverUrl);
        this.ws = ws;
        ws.onopen = () => {
          this.retryCount = 0;
          this.connecting = false;
          this.setStatus("connected");
          this.send({
            type: "register",
            id: this.genId(),
            payload: { nodeName: this.nodeName }
          });
          this.startPing();
        };
        ws.onmessage = (event) => {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }
          this.dispatch(msg);
        };
        ws.onerror = (e) => {
          e.preventDefault();
        };
        ws.onclose = () => {
          this.cancelPing();
          this.ws = null;
          this.onConnectFailed();
        };
      } catch {
        this.onConnectFailed();
      }
    }
    onConnectFailed() {
      this.cancelPing();
      this.ws = null;
      this.retryCount++;
      if (this.retryCount >= this.reconnectOptions.maxRetries) {
        this.connecting = false;
        this.nextRetryAt = Date.now() + this.reconnectOptions.retryIntervalMs;
        this.setStatus("disconnected");
        this.retryTimer = self.setTimeout(() => {
          this.retryCount = 0;
          this.connecting = true;
          this.nextRetryAt = null;
          this.setStatus("connecting");
          this.doConnect();
        }, this.reconnectOptions.retryIntervalMs);
      } else {
        this.retryTimer = self.setTimeout(() => {
          this.doConnect();
        }, 0);
        this.listeners.forEach((l) => l(this.status));
      }
    }
    cancelRetry() {
      if (this.retryTimer !== null) {
        self.clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.nextRetryAt = null;
    }
    startPing() {
      this.cancelPing();
      this.pingTimer = self.setInterval(() => {
        this.send({ type: "ping", id: this.genId(), payload: { timestamp: Date.now() } });
      }, 3e4);
    }
    cancelPing() {
      if (this.pingTimer !== null) {
        self.clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
    }
    dispatch(msg) {
      if (msg.type === "pong") return;
      const handlers = this.messageHandlers.get(msg.type);
      if (handlers) {
        handlers.forEach((h) => h(msg));
      }
      const wildcard = this.messageHandlers.get("*");
      if (wildcard) {
        wildcard.forEach((h) => h(msg));
      }
    }
    setStatus(s) {
      if (this.status === s) return;
      this.status = s;
      this.listeners.forEach((l) => l(s));
    }
    genId() {
      return Math.random().toString(36).slice(2, 10);
    }
    isValidUrl(url) {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "ws:" || parsed.protocol === "wss:";
      } catch {
        return false;
      }
    }
  };

  // src/background/cdp-elements.ts
  var CdpUnavailableError = class extends Error {
    constructor(detail) {
      super(`debugger unavailable: ${detail}`);
      this.name = "CdpUnavailableError";
      this.detail = detail;
    }
  };
  var StaleNodeError = class extends Error {
    constructor(backendNodeId) {
      super(
        `backendNodeId ${backendNodeId} no longer resolves to a node (page changed \u2014 re-run list_elements / get_rect for a fresh id)`
      );
      this.name = "StaleNodeError";
    }
  };
  async function resolveObjectId(send, backendNodeId) {
    try {
      const resolved = await send("DOM.resolveNode", { backendNodeId });
      return resolved?.object?.objectId ?? null;
    } catch {
      return null;
    }
  }
  async function attachDebugger(tabId) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (err) {
      throw new CdpUnavailableError(err instanceof Error ? err.message : String(err));
    }
  }
  async function detachDebugger(tabId) {
    await chrome.debugger.detach({ tabId }).catch(() => {
    });
  }
  async function enableDomains(send) {
    await send("DOM.enable");
    await send("Runtime.enable");
  }
  var HIDDEN_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "SVG", "PATH"]);
  var INTERACTIVE_TAGS = /* @__PURE__ */ new Set(["BUTTON", "A", "SELECT", "TEXTAREA", "INPUT", "LABEL"]);
  var INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "option",
    "combobox",
    "textbox",
    "listbox",
    "slider",
    "spinbutton",
    "searchbox"
  ]);
  function normalizeSpace(s) {
    return s.replace(/\s+/g, " ").trim();
  }
  function textContains(haystack, needle) {
    if (!needle) return true;
    if (haystack.includes(needle)) return true;
    return normalizeSpace(haystack).includes(normalizeSpace(needle));
  }
  function attrsOf(raw) {
    const out = {};
    const a = raw.attributes || [];
    for (let i = 0; i + 1 < a.length; i += 2) out[a[i]] = a[i + 1];
    return out;
  }
  async function readPiercedTree(send) {
    const doc = await send("DOM.getDocument", { depth: -1, pierce: true }, 15e3);
    const root = doc?.root;
    if (!root) throw new Error("DOM.getDocument returned no root node");
    const roots = [];
    const elements = [];
    const byNodeId = /* @__PURE__ */ new Map();
    const byBackendId = /* @__PURE__ */ new Map();
    const uncoveredIframes = [];
    let closedShadowRoots = 0;
    let nodeCount = 0;
    const walkContainer = (container, inClosed, inBody, frameUrl, shadowRootType) => {
      for (const c of container.children || []) {
        if (c.nodeType !== 1) continue;
        visit(c, inClosed, inBody, frameUrl, shadowRootType);
      }
    };
    const visit = (raw, inClosed, inBody, frameUrl, shadowRootType) => {
      nodeCount++;
      const el = {
        nodeId: raw.nodeId,
        backendNodeId: raw.backendNodeId,
        tag: raw.nodeName.toLowerCase(),
        nodeName: raw.nodeName,
        attributes: attrsOf(raw),
        inClosedShadowRoot: inClosed,
        text: "",
        visibleText: "",
        ...frameUrl ? { frameUrl } : {},
        ...shadowRootType ? { shadowRootType } : {},
        inBody: inBody || raw.nodeName === "BODY",
        children: []
      };
      elements.push(el);
      byNodeId.set(el.nodeId, el);
      byBackendId.set(el.backendNodeId, el);
      let rawText = "";
      for (const c of raw.children || []) {
        if (c.nodeType === 3) rawText += (c.nodeValue || "") + " ";
      }
      for (const c of raw.children || []) {
        if (c.nodeType !== 1) continue;
        el.children.push(visit(c, inClosed, el.inBody, frameUrl, shadowRootType));
      }
      el.text = normalizeSpace(`${rawText} ${el.children.map((k) => k.text).filter(Boolean).join(" ")}`);
      const own = HIDDEN_TAGS.has(raw.nodeName) ? "" : rawText;
      const kids = HIDDEN_TAGS.has(raw.nodeName) ? [] : el.children.map((k) => k.visibleText).filter(Boolean);
      el.visibleText = normalizeSpace(`${own} ${kids.join(" ")}`);
      for (const sr of raw.shadowRoots || []) {
        const srClosed = inClosed || sr.shadowRootType === "closed";
        if (sr.shadowRootType === "closed") closedShadowRoots++;
        roots.push({
          kind: "shadow-root",
          nodeId: sr.nodeId,
          backendNodeId: sr.backendNodeId,
          shadowRootType: sr.shadowRootType,
          inClosedShadowRoot: srClosed
        });
        walkContainer(sr, srClosed, true, frameUrl, sr.shadowRootType);
      }
      if (raw.nodeName === "IFRAME") {
        if (raw.contentDocument) {
          const cd = raw.contentDocument;
          roots.push({
            kind: "iframe-document",
            nodeId: cd.nodeId,
            backendNodeId: cd.backendNodeId,
            inClosedShadowRoot: inClosed,
            url: cd.baseURL,
            frameId: cd.frameId
          });
          walkContainer(cd, inClosed, false, cd.baseURL);
        } else {
          uncoveredIframes.push({
            src: el.attributes.src || "",
            ...frameUrl ? { inFrameUrl: frameUrl } : {}
          });
        }
      }
      return el;
    };
    roots.push({
      kind: "document",
      nodeId: root.nodeId,
      backendNodeId: root.backendNodeId,
      inClosedShadowRoot: false,
      url: root.baseURL,
      frameId: root.frameId
    });
    walkContainer(root, false, false, root.baseURL);
    const metrics = await send("Page.getLayoutMetrics").catch(() => null);
    const lv = metrics?.cssLayoutViewport;
    const dprRes = await send("Runtime.evaluate", {
      expression: "window.devicePixelRatio",
      returnByValue: true
    }).catch(() => null);
    return {
      roots,
      elements,
      byNodeId,
      byBackendId,
      closedShadowRoots,
      uncoveredIframes,
      scroll: { x: Math.round(lv?.pageX ?? 0), y: Math.round(lv?.pageY ?? 0) },
      viewport: { w: Math.round(lv?.clientWidth ?? 0), h: Math.round(lv?.clientHeight ?? 0) },
      dpr: typeof dprRes?.result?.value === "number" ? dprRes.result.value : 1,
      nodeCount
    };
  }
  function uncoveredIframeNote(tree) {
    if (tree.uncoveredIframes.length === 0) return void 0;
    const list = tree.uncoveredIframes.map((f) => f.src || "(no src)").join(", ");
    return `closed-shadow piercing does not cover ${tree.uncoveredIframes.length} iframe(s) whose document is not in this page's process (cross-origin frame, or not loaded yet): ${list}. Elements inside them are not reported; this is a boundary, not an empty result.`;
  }
  function textMatches(value, q) {
    return q.exact ? normalizeSpace(value) === normalizeSpace(q.text) || value === q.text : textContains(value, q.text);
  }
  function findByTextInTree(tree, q) {
    const collect = (basisOf) => {
      const hits = [];
      for (const el of tree.elements) {
        if (!el.inBody) continue;
        if (HIDDEN_TAGS.has(el.nodeName)) continue;
        const own = basisOf(el);
        if (!textMatches(own, q)) continue;
        const isButtonOrLink = el.nodeName === "BUTTON" || el.nodeName === "A";
        const isInput = el.nodeName === "INPUT" && textMatches(el.attributes.value || "", q);
        if (isButtonOrLink || isInput) {
          hits.push(el);
          continue;
        }
        const childHit = el.children.some((c) => !HIDDEN_TAGS.has(c.nodeName) && textMatches(basisOf(c), q));
        if (!childHit) hits.push(el);
      }
      return hits;
    };
    const visible = collect((el) => el.visibleText);
    return visible.length > 0 ? visible : collect((el) => el.text);
  }
  function selectorKind(selector) {
    if (selector.startsWith("xpath:")) return "xpath";
    const css = selector.startsWith("css:") ? selector.slice(4) : selector;
    let quote = null;
    let depth = 0;
    for (let i = 0; i < css.length; i++) {
      const ch = css[i];
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
      if (ch === ">" && css[i + 1] === ">" && css[i + 2] === ">") return "path";
      if (css.startsWith("#shadow-root", i)) return "path";
    }
    return "css";
  }
  async function querySelectorInTree(send, tree, selector) {
    const css = selector.startsWith("css:") ? selector.slice(4) : selector;
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    let lastError;
    for (const root of tree.roots) {
      if (root.shadowRootType === "user-agent") continue;
      let res = null;
      try {
        res = await send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: css });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      for (const nodeId of res?.nodeIds || []) {
        const el = tree.byNodeId.get(nodeId);
        if (!el || seen.has(el.backendNodeId)) continue;
        seen.add(el.backendNodeId);
        out.push(el);
      }
    }
    if (out.length === 0 && lastError) return { hits: out, error: lastError };
    return { hits: out };
  }
  var FACT_FN = `function(){
  const el = this;
  let display = null, visibility = null;
  try { const cs = getComputedStyle(el); display = cs.display; visibility = cs.visibility; } catch (e) {}
  const attr = function(n){ return el.getAttribute ? el.getAttribute(n) : null; };
  const inner = el.innerText === undefined ? (el.textContent || "") : el.innerText;
  const out = {
    tag: el.tagName ? String(el.tagName).toLowerCase() : String(el.nodeName || "").toLowerCase(),
    class: Array.from(el.classList || []).slice(0, 3).join("."),
    text: String(inner).trim().replace(/\\s+/g, " "),
    rawText: el.textContent === undefined ? "" : String(el.textContent),
    display: display,
    visibility: visibility
  };
  if (el.isContentEditable) out.editable = true;
  const role = attr("role"); if (role) out.role = role.toLowerCase();
  const ariaLabel = attr("aria-label"); if (ariaLabel) out.ariaLabel = ariaLabel;
  const title = attr("title"); if (title) out.title = title;
  if (out.tag === "input") {
    if (el.type) out.type = el.type;
    if (el.accept) out.accept = el.accept;
    if (el.multiple) out.multiple = true;
    if (el.name) out.name = el.name;
    if (el.placeholder) out.placeholder = el.placeholder;
  }
  return out;
}`;
  async function factsOf(send, backendNodeId) {
    try {
      const resolved = await send("DOM.resolveNode", { backendNodeId });
      const objectId = resolved?.object?.objectId;
      if (!objectId) return {};
      const res = await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: FACT_FN,
        returnByValue: true
      });
      return res?.result?.value || {};
    } catch {
      return {};
    }
  }
  async function boxOf(send, backendNodeId) {
    const rect = await quadsBbox(send, backendNodeId);
    if (!rect) return null;
    return { rectCss: rect, centerCss: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } };
  }
  async function quadsBbox(send, backendNodeId) {
    const bbox = (quads) => {
      if (!quads || quads.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of quads) {
        for (let i = 0; i + 1 < q.length; i += 2) {
          minX = Math.min(minX, q[i]);
          minY = Math.min(minY, q[i + 1]);
          maxX = Math.max(maxX, q[i]);
          maxY = Math.max(maxY, q[i + 1]);
        }
      }
      if (!(maxX >= minX) || !(maxY >= minY)) return null;
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    };
    try {
      const res = await send("DOM.getBoxModel", { backendNodeId });
      const hit = bbox(res?.model?.border ? [res.model.border] : void 0);
      if (hit) return hit;
    } catch {
    }
    try {
      const res = await send("DOM.getContentQuads", { backendNodeId });
      return bbox(res?.quads);
    } catch {
      return null;
    }
  }
  async function describeElements(send, items) {
    const out = [];
    for (const el of items) {
      const raw = await factsOf(send, el.backendNodeId);
      const box = await boxOf(send, el.backendNodeId);
      out.push({
        tag: raw.tag || el.tag,
        ...raw.class ? { class: raw.class } : {},
        text: raw.text !== void 0 ? raw.text : el.text,
        rawText: raw.rawText !== void 0 ? raw.rawText : el.text,
        rectCss: box ? box.rectCss : null,
        centerCss: box ? box.centerCss : null,
        visible: !!box && box.rectCss.w > 0 && box.rectCss.h > 0 && raw.display !== "none" && raw.visibility !== "hidden",
        backendNodeId: el.backendNodeId,
        inClosedShadowRoot: el.inClosedShadowRoot,
        ...raw.editable ? { editable: true } : {},
        ...el.frameUrl ? { frameUrl: el.frameUrl } : {},
        ...raw.role ? { role: raw.role } : {},
        ...raw.ariaLabel ? { ariaLabel: raw.ariaLabel } : {},
        ...raw.title ? { title: raw.title } : {},
        ...raw.type ? { type: raw.type } : {},
        ...raw.accept ? { accept: raw.accept } : {},
        ...raw.multiple ? { multiple: true } : {},
        ...raw.name ? { name: raw.name } : {},
        ...raw.placeholder ? { placeholder: raw.placeholder } : {}
      });
    }
    return out;
  }
  function syntheticElement(backendNodeId) {
    return {
      nodeId: 0,
      backendNodeId,
      tag: "",
      nodeName: "",
      attributes: {},
      inClosedShadowRoot: false,
      text: "",
      visibleText: "",
      inBody: true,
      children: []
    };
  }
  async function describeBackendNode(send, tree, backendNodeId) {
    const known = tree.byBackendId.get(backendNodeId);
    const [facts] = await describeElements(send, [known || syntheticElement(backendNodeId)]);
    return facts ?? null;
  }
  async function isSelfOrDescendant(send, targetBackendNodeId, hitBackendNodeId) {
    if (targetBackendNodeId === hitBackendNodeId) return true;
    const targetObj = await resolveObjectId(send, targetBackendNodeId);
    const hitObj = await resolveObjectId(send, hitBackendNodeId);
    if (!targetObj || !hitObj) return false;
    try {
      const res = await send("Runtime.callFunctionOn", {
        objectId: targetObj,
        functionDeclaration: "function(other){ return !!(this.contains && this.contains(other)); }",
        arguments: [{ objectId: hitObj }],
        returnByValue: true
      });
      return res?.result?.value === true;
    } catch {
      return false;
    }
  }
  async function hitTestAt(send, tree, x, y) {
    const fresh = await send("Page.getLayoutMetrics").catch(() => null);
    const lv = fresh?.cssLayoutViewport;
    const scrollX = typeof lv?.pageX === "number" ? Math.round(lv.pageX) : tree.scroll.x;
    const scrollY = typeof lv?.pageY === "number" ? Math.round(lv.pageY) : tree.scroll.y;
    const px = Math.round(x + scrollX);
    const py = Math.round(y + scrollY);
    let loc = null;
    try {
      loc = await send("DOM.getNodeForLocation", { x: px, y: py });
    } catch {
      return null;
    }
    const backendNodeId = loc?.backendNodeId;
    if (backendNodeId == null) return null;
    const known = tree.byBackendId.get(backendNodeId);
    const [facts] = await describeElements(send, [known || syntheticElement(backendNodeId)]);
    if (!facts) return null;
    return { ...facts, ...loc?.frameId ? { frameId: loc.frameId } : {} };
  }
  function toHitDescription(facts) {
    return {
      tag: facts.tag,
      ...facts.class ? { class: facts.class } : {},
      ...facts.rawText ? { text: facts.rawText } : {},
      backendNodeId: facts.backendNodeId,
      inClosedShadowRoot: facts.inClosedShadowRoot
    };
  }
  async function scrollIntoView(send, backendNodeId) {
    await send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {
    });
  }
  var CLICK_FN = `function(){
  const r = this.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
  this.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, base, { buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true })));
  this.dispatchEvent(new MouseEvent("mousedown", Object.assign({}, base, { buttons: 1 })));
  this.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true })));
  this.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, base, { buttons: 0 })));
  this.dispatchEvent(new MouseEvent("click", Object.assign({}, base, { buttons: 0 })));
  return { cx: cx, cy: cy };
}`;
  async function dispatchSyntheticClick(send, backendNodeId) {
    const objectId = await resolveObjectId(send, backendNodeId);
    if (!objectId) throw new StaleNodeError(backendNodeId);
    const res = await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: CLICK_FN,
      returnByValue: true,
      userGesture: true
    });
    const v = res?.result?.value;
    if (!v || typeof v.cx !== "number" || typeof v.cy !== "number") return null;
    return { cx: v.cx, cy: v.cy };
  }
  async function textOf(send, backendNodeId) {
    const objectId = await resolveObjectId(send, backendNodeId);
    if (!objectId) throw new StaleNodeError(backendNodeId);
    const res = await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){ return this.textContent === undefined ? null : this.textContent; }",
      returnByValue: true
    });
    const text = res?.result?.value;
    return typeof text === "string" ? text : null;
  }
  async function propertyOf(send, backendNodeId, prop) {
    const objectId = await resolveObjectId(send, backendNodeId);
    if (!objectId) return { ok: false, error: new StaleNodeError(backendNodeId).message };
    const fn = `function(p){
    const tag = this.tagName ? String(this.tagName).toLowerCase() : String(this.nodeName || "");
    if (!p) return { err: "empty" };
    if (!(p in this)) return { err: "absent", tag: tag };
    const v = this[p];
    if (typeof v === "function") return { err: "function", tag: tag };
    if (v === undefined) return { err: "undefined", tag: tag };
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        return { err: "nonplain", tag: tag, ctor: (v.constructor && v.constructor.name) || "object" };
      }
    }
    return { value: v };
  }`;
    try {
      const res = await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fn,
        arguments: [{ value: prop }],
        returnByValue: true
      });
      const out = res?.result?.value;
      if (!out) return { ok: false, error: `Could not read property "${prop}" from the element` };
      if (out.err === "absent") {
        return { ok: false, error: `No property "${prop}" on <${out.tag}> \u2014 examples: "innerHTML", "textContent", "value", "className", "checked", "id", "src", "href", "dataset"` };
      }
      if (out.err === "function") return { ok: false, error: `"${prop}" is a method on <${out.tag}> \u2014 get_prop only reads properties, it never calls methods` };
      if (out.err === "undefined") return { ok: false, error: `Property "${prop}" on <${out.tag}> is undefined (element found, but the property has no value)` };
      if (out.err === "nonplain") {
        return { ok: false, error: `Property "${prop}" on <${out.tag}> holds a ${out.ctor || "non-plain"} object \u2014 only plain data can be returned; read a string/number property like "innerHTML" or "value" instead` };
      }
      return { ok: true, value: out.value };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Property "${prop}" could not be serialized: ${detail}` };
    }
  }
  async function waitViewportStable(send, opts = {}) {
    const intervalMs = opts.intervalMs ?? 120;
    const settleMs = opts.settleMs ?? 300;
    const baseline = typeof opts.inPageViewportH === "number" ? opts.inPageViewportH : null;
    const maxMs = opts.maxMs ?? (baseline !== null ? 2500 : 1200);
    const started = Date.now();
    let prev = null;
    let readings = 0;
    let stableSince = 0;
    let sawInfobar = false;
    let last = { w: 0, h: 0 };
    for (; ; ) {
      const m = await send("Page.getLayoutMetrics").catch(() => null);
      const lv = m?.cssLayoutViewport;
      last = { w: Math.round(lv?.clientWidth ?? 0), h: Math.round(lv?.clientHeight ?? 0) };
      readings++;
      if (baseline !== null && last.h > 0 && last.h < baseline) sawInfobar = true;
      const waitingForInfobar = baseline !== null && !sawInfobar;
      if (prev && prev.w === last.w && prev.h === last.h) {
        if (!stableSince) stableSince = Date.now();
        if (!waitingForInfobar && Date.now() - stableSince >= settleMs) {
          return {
            viewportCss: last,
            settled: true,
            waitedMs: Date.now() - started,
            readings,
            ...baseline !== null ? { sawInfobar } : {}
          };
        }
      } else {
        stableSince = 0;
      }
      if (Date.now() - started >= maxMs) {
        return {
          viewportCss: last,
          settled: false,
          waitedMs: Date.now() - started,
          readings,
          ...baseline !== null ? { sawInfobar } : {}
        };
      }
      prev = last;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  async function viewportFacts(send) {
    const metrics = await send("Page.getLayoutMetrics");
    const lv = metrics?.cssLayoutViewport;
    const dprRes = await send("Runtime.evaluate", {
      expression: "window.devicePixelRatio",
      returnByValue: true
    });
    return {
      viewportCss: { w: Math.round(lv?.clientWidth ?? 0), h: Math.round(lv?.clientHeight ?? 0) },
      scrollCss: { x: Math.round(lv?.pageX ?? 0), y: Math.round(lv?.pageY ?? 0) },
      dpr: typeof dprRes?.result?.value === "number" ? dprRes.result.value : 1
    };
  }
  async function listClosedInteractive(send, tree, filter = {}) {
    const candidates = tree.elements.filter((el) => {
      if (!el.inClosedShadowRoot) return false;
      if (el.shadowRootType === "user-agent") return false;
      if (HIDDEN_TAGS.has(el.nodeName)) return false;
      if (INTERACTIVE_TAGS.has(el.nodeName)) return true;
      if ("contenteditable" in el.attributes) return true;
      if ("tabindex" in el.attributes) return true;
      if ("role" in el.attributes) {
        return INTERACTIVE_ROLES.has((el.attributes.role || "").trim().toLowerCase());
      }
      return false;
    });
    if (candidates.length === 0) return [];
    const facts = await describeElements(send, candidates);
    const textFilter = filter.text ?? "";
    const filters = filter.filters ?? [];
    const out = [];
    for (const f of facts) {
      if (filter.visibleOnly && !f.visible) continue;
      if (filter.hiddenOnly && f.visible) continue;
      if (!textContains(f.rawText, textFilter)) continue;
      if (filters.length > 0) {
        const hit = filters.some((name) => {
          switch (name) {
            case "button":
              return f.tag === "button" || f.role === "button";
            case "link":
              return f.tag === "a" || f.role === "link";
            case "input":
              return f.tag === "input";
            case "select":
              return f.tag === "select";
            case "textarea":
              return f.tag === "textarea";
            case "label":
              return f.tag === "label";
            // 与 content script 的 `html.isContentEditable || …` 对齐：editable 这个事实
            // 必须从活 DOM 取（继承的 contenteditable / designMode 在属性上看不出来）
            case "editable":
              return !!f.editable || f.tag === "textarea" || f.tag === "input" && !!f.type && /text|search|email|url|tel|number|password|date|time|datetime-local|month|week/.test(f.type);
            case "upload":
              return f.tag === "input" && f.type === "file" || /点击上传|上传|拖入|拖拽|拖到|upload|drop/i.test(f.text);
            default:
              return true;
          }
        });
        if (!hit) continue;
      }
      const r = f.rectCss;
      const item = {
        tag: f.tag,
        visible: f.visible,
        // 坐标 = 顶层视口 CSS px（与 real_click / get_rect.centerCss 同口径）
        x: r ? Math.round(r.x) : 0,
        y: r ? Math.round(r.y) : 0,
        w: r ? Math.round(r.w) : 0,
        h: r ? Math.round(r.h) : 0,
        backendNodeId: f.backendNodeId,
        inClosedShadowRoot: true
      };
      if (f.role) item.role = f.role;
      if (f.ariaLabel) item.ariaLabel = f.ariaLabel;
      if (f.title) item.title = f.title;
      if (f.type) item.type = f.type;
      if (f.accept) item.accept = f.accept;
      if (f.multiple) item.multiple = true;
      if (f.name) item.name = f.name;
      if (f.placeholder) item.placeholder = f.placeholder;
      if (f.rawText) item.text = f.rawText;
      out.push(item);
    }
    return out;
  }

  // src/background/service-worker.ts
  var wsClient = new WsClient({
    maxRetries: 3,
    retryIntervalMs: 15e3
  });
  var BROWSER_COMMANDS = /* @__PURE__ */ new Set(["open", "list_tabs", "close_tab", "refresh"]);
  var REAL_CLICK_COMMANDS = /* @__PURE__ */ new Set(["real_click", "screenshot"]);
  var lastMouseX = 0;
  var lastMouseY = 0;
  function cdpSend(tabId, method, params, timeoutMs = 1e4) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.debugger.detach({ tabId }).catch(() => {
        });
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      try {
        chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }
  function withStepTimeout(step, ms, p) {
    return Promise.race([
      p,
      new Promise(
        (_, reject) => setTimeout(() => reject(new Error(`step "${step}" did not settle within ${ms}ms`)), ms)
      )
    ]);
  }
  var ERR_NOT_FOUND = "not-found";
  var ERR_UNREACHABLE = "unreachable-subtree";
  var ERR_CDP = "cdp-unavailable";
  var INFOBAR_SLACK_CSS = 64;
  var NOT_FOUND_HINT = ' \u2014 run list_elements to see what is actually on the page; elements inside closed shadow roots only appear with list_elements {"closed":true} and are then addressed by backendNodeId';
  function cdpErrorCode(err) {
    if (err instanceof CdpUnavailableError) return ERR_CDP;
    if (err instanceof StaleNodeError) return ERR_UNREACHABLE;
    return void 0;
  }
  async function inPageViewportHeight(tabId) {
    const { response } = await sendToFrame(
      tabId,
      0,
      { type: "execute_command", payload: { command: "get_viewport", params: {} } },
      1200
    );
    const d = response?.data;
    const h = d?.viewportCss?.h;
    return typeof h === "number" && h > 0 ? h : null;
  }
  var INFOBAR_SUPPRESSED_KEY = "debuggerInfobarSuppressed";
  async function settleAttachedViewport(send, tabId) {
    const baseline = await inPageViewportHeight(tabId);
    const flags = await withStepTimeout(
      "read the infobar-suppression flag",
      2e3,
      chrome.storage.session.get(INFOBAR_SUPPRESSED_KEY)
    ).catch(() => ({}));
    const suppressed = baseline !== null && flags[INFOBAR_SUPPRESSED_KEY] === true;
    if (!suppressed) {
      const wait = await waitViewportStable(send, { inPageViewportH: baseline });
      if (baseline !== null && wait.sawInfobar === false) {
        chrome.storage.session.set({ [INFOBAR_SUPPRESSED_KEY]: true }).catch(() => {
        });
      }
      return wait;
    }
    const recheck = await waitViewportStable(send, { inPageViewportH: baseline, maxMs: 500 });
    if (recheck.sawInfobar === true) {
      chrome.storage.session.remove(INFOBAR_SUPPRESSED_KEY).catch(() => {
      });
      return await waitViewportStable(send, { inPageViewportH: baseline });
    }
    return { ...recheck, settled: true, sawInfobar: false };
  }
  async function withPiercedTree(tabId, fn) {
    await attachDebugger(tabId);
    try {
      const send = (method, params, timeoutMs) => cdpSend(tabId, method, params, timeoutMs);
      await enableDomains(send);
      const wait = await settleAttachedViewport(send, tabId);
      const tree = await readPiercedTree(send);
      tree.viewportSettled = wait.settled;
      tree.sawInfobar = wait.sawInfobar;
      return await fn(send, tree);
    } finally {
      await detachDebugger(tabId);
    }
  }
  async function rectPayloadFromFacts(send, tree, facts) {
    const rectCss = facts.rectCss;
    const centerCss = facts.centerCss;
    const hit = centerCss ? await hitTestAt(send, tree, centerCss.x, centerCss.y) : null;
    const covered = !!hit && hit.backendNodeId !== facts.backendNodeId && !await isSelfOrDescendant(send, facts.backendNodeId, hit.backendNodeId);
    return {
      x: centerCss ? Math.round(centerCss.x) : 0,
      y: centerCss ? Math.round(centerCss.y) : 0,
      width: rectCss ? Math.round(rectCss.w) : 0,
      height: rectCss ? Math.round(rectCss.h) : 0,
      rectCss,
      centerCss,
      tag: facts.tag,
      class: facts.class ?? "",
      text: facts.text,
      visible: facts.visible,
      covered,
      hitTest: hit ? toHitDescription(hit) : null,
      backendNodeId: facts.backendNodeId,
      inClosedShadowRoot: facts.inClosedShadowRoot,
      source: "cdp-pierced",
      // 这份几何是在**附加了 debugger 的视口**里量的（信息条占掉顶部一条，见 waitViewportStable）。
      // 带上它，调用方才能发现「这里的视口比 get_viewport 报的矮」并据此配对：
      // CDP 通道的坐标配 real_click / click {backendNodeId} / screenshot 换算；
      // 页面内通道（get_viewport / list_elements 普通条目 / click {x,y}）是另一个空间。
      // 同一页面里两者对底部/垂直居中/vh 类元素会差一个信息条的高度（实测 56px）。
      viewportCss: tree.viewport,
      // 这次附加**没**观察到视口变矮（本会话没有信息条，或者它早就浮在那里、这次没再改变什么）：
      // 此时这份几何与页面内通道恰好同空间——如实说出来，调用方才知道该拿它配谁
      // （此时配 click {x,y} / get_viewport 是对的）。判据是"没观察到差异"，不是"信息条不存在"。
      ...tree.sawInfobar === false ? { viewportNote: "measured in the same viewport space as get_viewport / click {x,y} (no debugger-infobar difference observed in this attach) \u2014 bottom-anchored coordinates from the CDP channel and the in-page channels agree here" } : {},
      ...facts.frameUrl ? { frameUrl: facts.frameUrl } : {}
    };
  }
  async function locateInTree(send, tree, params) {
    const backendNodeId = params.backendNodeId;
    if (typeof backendNodeId === "number") {
      const known = tree.byBackendId.get(backendNodeId);
      return { hits: known ? [known] : [syntheticTarget(backendNodeId)], allMatches: void 0 };
    }
    const selector = typeof params.selector === "string" ? params.selector : "";
    if (selector) {
      const kind = selectorKind(selector);
      if (kind !== "css") {
        return { hits: [], note: `"${kind}"-style selectors (xpath: / >>> / #shadow-root) cannot address nodes inside a closed shadow root \u2014 closed shadow roots have no stable path. Use a plain CSS selector or a text query instead.` };
      }
      const { hits: hits2, error } = await querySelectorInTree(send, tree, selector);
      if (error) return { hits: [], note: error };
      return { hits: hits2, allMatches: void 0 };
    }
    const text = typeof params.text === "string" ? params.text : "";
    if (!text) return { hits: [] };
    const hits = findByTextInTree(tree, { text, exact: params.exact === true });
    return { hits };
  }
  var MATCH_LIMIT = 20;
  var MATCH_LIMIT_ALL = 100;
  var DESCRIBE_LIMIT = 60;
  var DESCRIBE_LIMIT_ALL = 100;
  function identityOf(facts, backendNodeId) {
    return {
      backendNodeId,
      inClosedShadowRoot: facts?.inClosedShadowRoot === true
    };
  }
  var BACKEND_ID_COMMANDS = /* @__PURE__ */ new Set(["get_rect", "get_prop", "get_text", "click"]);
  async function byBackendNodeId(tabId, command, params) {
    const backendNodeId = params.backendNodeId;
    if (!BACKEND_ID_COMMANDS.has(command)) {
      return {
        ok: false,
        error: `{backendNodeId} is not supported by "${command}" \u2014 it works with get_rect / get_prop / get_text / click / real_click. Closed shadow root nodes have no selector, so commands that need one (type/keyboard/trigger/upload_*) cannot address them; if the element is inside an open shadow root, target it with a ">>>" selector instead`
      };
    }
    try {
      return await withPiercedTree(tabId, async (send, tree) => {
        const facts = await describeBackendNode(send, tree, backendNodeId);
        if (command === "get_text") {
          const text = await textOf(send, backendNodeId);
          return { ok: true, data: { text, ...identityOf(facts, backendNodeId) } };
        }
        if (command === "get_prop") {
          const prop = typeof params.prop === "string" ? params.prop : "";
          if (!prop) return { ok: false, error: '"prop" is required with "backendNodeId"' };
          const r = await propertyOf(send, backendNodeId, prop);
          return r.ok ? { ok: true, data: { prop, value: r.value, ...identityOf(facts, backendNodeId) } } : { ok: false, error: r.error };
        }
        if (command === "click") {
          const pt = await dispatchSyntheticClick(send, backendNodeId);
          if (!pt) return { ok: false, code: ERR_UNREACHABLE, error: `backendNodeId ${backendNodeId} did not accept a synthetic click` };
          const box = await boxOf(send, backendNodeId).catch(() => null);
          const cx = box?.centerCss.x ?? pt.cx;
          const cy = box?.centerCss.y ?? pt.cy;
          const hitTest = await hitTestAt(send, tree, cx, cy).catch(() => null);
          const covered = !!hitTest && !await isSelfOrDescendant(send, backendNodeId, hitTest.backendNodeId);
          return {
            ok: true,
            data: {
              clickDesc: {
                x: Math.round(cx),
                y: Math.round(cy),
                tag: facts?.tag,
                ...facts?.class ? { class: facts.class } : {},
                backendNodeId,
                inClosedShadowRoot: facts?.inClosedShadowRoot === true,
                ...covered && hitTest ? { coveredBy: toHitDescription(hitTest) } : {}
              }
            }
          };
        }
        if (!facts) return { ok: false, code: ERR_NOT_FOUND, error: `backendNodeId ${backendNodeId} does not exist in the pierced DOM (page changed \u2014 re-run list_elements for a fresh id)` };
        if (!facts.visible) {
          return {
            ok: false,
            code: ERR_UNREACHABLE,
            error: `backendNodeId ${backendNodeId} (${facts.tag}) exists but has no usable geometry (zero-size or hidden) \u2014 reachable in the tree, not usable as a coordinate target`
          };
        }
        return { ok: true, data: await rectPayloadFromFacts(send, tree, facts) };
      });
    } catch (err) {
      const code = cdpErrorCode(err);
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, code, error: code ? detail : `backendNodeId lookup failed: ${detail}` };
    }
  }
  async function rectViaContentScript(tabId, params, timeoutMs = 5e3) {
    const frames = await resolveSearchFrames(tabId, params.frame);
    let responded = false;
    for (const f of frames) {
      const { response } = await sendToFrame(tabId, f.frameId, {
        type: "execute_command",
        payload: { command: "get_rect", params }
      }, timeoutMs);
      if (!response) continue;
      responded = true;
      if (response.notFound) continue;
      return { data: response.data, responded };
    }
    return { responded };
  }
  async function resolveRectsViaCdp(tabId, queries) {
    const out = /* @__PURE__ */ new Map();
    const describeLimit = queries.some((q) => q.params.all === true) ? DESCRIBE_LIMIT_ALL : DESCRIBE_LIMIT;
    try {
      await withPiercedTree(tabId, async (send, tree) => {
        const boundaryNote = uncoveredIframeNote(tree);
        for (const q of queries) {
          const located = await locateInTree(send, tree, q.params);
          if (located.note) {
            out.set(q.key, { ok: false, code: ERR_UNREACHABLE, error: located.note });
            continue;
          }
          if (located.hits.length === 0) {
            out.set(q.key, { ok: false, code: ERR_NOT_FOUND, error: `Element not found: ${q.params.text || q.params.selector}${NOT_FOUND_HINT}` });
            continue;
          }
          const described = located.hits.slice(0, describeLimit);
          const facts = await describeElements(send, described);
          const primary = facts.find((f) => f.visible);
          if (!primary) {
            out.set(q.key, {
              ok: false,
              code: ERR_UNREACHABLE,
              error: `Element exists in the pierced DOM (${located.hits.length} match(es)) but none of the first ${described.length} has usable geometry (zero-size or hidden) \u2014 reachable in the tree, not usable as a coordinate target`
            });
            continue;
          }
          const payload = await rectPayloadFromFacts(send, tree, primary);
          const matchCount = located.hits.length;
          const allMatches = [];
          const limit = q.params.all === true ? MATCH_LIMIT_ALL : MATCH_LIMIT;
          let truncated = located.hits.length > described.length;
          if (q.params.text && (q.params.all === true || matchCount > 1)) {
            let priority = 0;
            for (const f of facts) {
              if (allMatches.length >= limit) {
                truncated = true;
                break;
              }
              const r = f.rectCss;
              allMatches.push({
                tag: f.tag,
                class: f.class ?? "",
                text: f.text,
                rectCss: r,
                visible: f.visible,
                // priority 只在可见候选间计数：0 = 文本定位会选中的那个（与页面内同口径）
                ...f.visible ? { priority: priority++ } : {},
                backendNodeId: f.backendNodeId,
                inClosedShadowRoot: f.inClosedShadowRoot
              });
            }
          }
          out.set(q.key, {
            ok: true,
            data: {
              ...typeof q.params.selector === "string" ? { selector: q.params.selector } : {},
              ...payload,
              matchCount,
              ...allMatches.length ? { allMatches } : {},
              ...truncated ? { truncated: true } : {},
              ...boundaryNote ? { boundary: boundaryNote } : {}
            }
          });
        }
      });
    } catch (err) {
      const code = cdpErrorCode(err);
      const detail = err instanceof Error ? err.message : String(err);
      for (const q of queries) {
        if (out.has(q.key)) continue;
        out.set(q.key, {
          ok: false,
          code,
          error: code ? detail : `CDP fallback failed: ${detail}`
        });
      }
    }
    return out;
  }
  function syntheticTarget(backendNodeId) {
    return {
      nodeId: 0,
      backendNodeId,
      tag: "",
      nodeName: "",
      attributes: {},
      inClosedShadowRoot: false,
      text: "",
      visibleText: "",
      inBody: true,
      children: []
    };
  }
  async function moveMouseBounded(tabId, x, y, warnings) {
    try {
      await withStepTimeout(`move the mouse to ${x},${y}`, 15e3, moveMouseInSteps(tabId, x, y));
    } catch (e) {
      warnings.push(`the mouse move to (${x}, ${y}) did not finish (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  async function activateTabBounded(tabId) {
    try {
      const tab = await withStepTimeout("read the tab", 3e3, chrome.tabs.get(tabId));
      if (tab.windowId != null) {
        await withStepTimeout("focus the window", 3e3, chrome.windows.update(tab.windowId, { focused: true }));
      }
      await withStepTimeout("activate the tab", 3e3, chrome.tabs.update(tabId, { active: true }));
      return void 0;
    } catch (e) {
      return `could not bring the tab to the front (${e instanceof Error ? e.message : String(e)}) \u2014 the action was dispatched anyway; if nothing happened, focus that window/tab and retry`;
    }
  }
  async function moveMouseInSteps(tabId, tx, ty) {
    const dx = tx - lastMouseX;
    const dy = ty - lastMouseY;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    const steps = Math.max(1, Math.ceil(dist / 10));
    for (let i = 1; i <= steps; i++) {
      const px = Math.round(lastMouseX + dx * i / steps);
      const py = Math.round(lastMouseY + dy * i / steps);
      await cdpSend(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: px,
        y: py,
        button: "none"
      });
      await new Promise((r) => setTimeout(r, 15));
    }
    lastMouseX = tx;
    lastMouseY = ty;
  }
  var BLOCKED_COMMANDS = /* @__PURE__ */ new Set(["wait_for_page", "wait_for_settle"]);
  var GROUP_TITLE = "chrome_do_action";
  var groupId = null;
  var groupWindowId = null;
  var origConsoleError = console.error;
  console.error = (...args) => {
    const msg = args.join(" ");
    if (/WebSocket|ws:/i.test(msg)) return;
    origConsoleError.apply(console, args);
  };
  chrome.runtime.onInstalled.addListener(async () => {
    const result = await chrome.storage.local.get(["nodeName", "serverUrl", "autoConnect", "allowExec"]);
    if (!result.nodeName && !result.serverUrl) {
      await chrome.storage.local.set({
        nodeName: "",
        serverUrl: "",
        autoConnect: true,
        allowExec: false
        // exec 高风险能力：默认关闭，仅在配置页显式勾选后可用
      });
    }
    await ensureAlarm();
    autoConnect();
  });
  wsClient.onStatusChange((status) => {
    updateBadge(status);
    notifyPorts(status);
    if (status === "connected") {
      chrome.storage.session.remove("manualDisconnect").catch(() => {
      });
    }
  });
  wsClient.onMessage("command", (msg) => {
    if (msg.type !== "command") return;
    const cmd = msg;
    if (cmd.payload.command === "exec") {
      void handleExecCommand(cmd);
      return;
    }
    if (BROWSER_COMMANDS.has(cmd.payload.command)) {
      handleBrowserCommand(cmd);
      return;
    }
    if (BLOCKED_COMMANDS.has(cmd.payload.command)) {
      wsClient.send({
        type: "command_result",
        payload: { commandId: cmd.id, success: false, error: `Command "${cmd.payload.command}" is not available` }
      });
      return;
    }
    if (REAL_CLICK_COMMANDS.has(cmd.payload.command)) {
      handleRealClick(cmd);
      return;
    }
    if (cmd.payload.command === "upload_dragdrop" && cmd.payload.params?.trusted === true) {
      handleTrustedDrop(cmd);
      return;
    }
    const tabId = cmd.payload.params?.tabId;
    const params = { ...cmd.payload.params };
    delete params.tabId;
    if (tabId != null) {
      enqueueCommand(tabId, cmd, params);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tid = tabs[0]?.id;
        if (!tid) {
          wsClient.send({
            type: "command_result",
            payload: { commandId: cmd.id, success: false, error: "No active tab" }
          });
          return;
        }
        enqueueCommand(tid, cmd, params);
      });
    }
  });
  chrome.runtime.onMessage.addListener(
    (msg, sender, sendResponse) => {
      if (msg.type === "cs_injected") {
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "connect") {
        const { serverUrl, nodeName } = msg;
        if (serverUrl && nodeName) {
          chrome.storage.local.set({ serverUrl, nodeName });
          wsClient.connect(serverUrl, nodeName);
          sendResponse({ status: wsClient.getStatus() });
        }
      } else if (msg.type === "disconnect") {
        wsClient.disconnect();
        chrome.storage.session.set({ manualDisconnect: true }).catch(() => {
        });
        sendResponse({ status: wsClient.getStatus() });
      } else if (msg.type === "get_status") {
        sendResponse({ status: wsClient.getStatus(), retry: wsClient.getRetryState() });
      } else if (msg.type === "debug_mode") {
        const tabId = sender.tab?.id;
        const state = msg.payload?.state;
        if (tabId == null || typeof state !== "string") {
          sendResponse({ ok: false, error: "debug_mode \u7F3A\u5C11 tab/state" });
        } else {
          void broadcastDebugSession(tabId, state, sendResponse);
        }
      } else if (msg.type === "debug_broadcast") {
        const tabId = sender.tab?.id;
        const command = msg.payload?.command;
        if (tabId == null || typeof command !== "string") {
          sendResponse({ success: false, error: "debug_broadcast \u7F3A\u5C11 tab/command" });
        } else {
          void broadcastDebugCommand(tabId, command, sendResponse);
        }
      } else if (msg.type === "debug_pick_selected" || msg.type === "debug_pick_esc") {
        const tabId = sender.tab?.id;
        const payload = msg.payload;
        if (tabId == null || sender.frameId == null) {
          sendResponse({ ok: false, error: "debug_pick \u7F3A\u5C11 tab/frame" });
        } else {
          void forwardDebugPick(tabId, msg.type, payload, sender.frameId, sendResponse);
        }
      } else if (msg.type === "debug_execute") {
        const tabId = sender.tab?.id;
        const payload = msg.payload;
        if (tabId == null || !payload || typeof payload.command !== "string") {
          sendResponse({ success: false, error: "debug_execute \u7F3A\u5C11\u53C2\u6570" });
        } else {
          void runDebugExecute(tabId, payload, sendResponse);
        }
      } else if (msg.type === "debug_real_click") {
        const tabId = sender.tab?.id;
        const p = msg.payload;
        const x = p?.x;
        const y = p?.y;
        if (tabId == null || typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
          sendResponse({ success: false, error: "debug_real_click \u9700\u8981\u6570\u5B57\u5750\u6807 {x, y}" });
        } else {
          void runDebugRealClick(tabId, x, y, msg.payload?.chain, sendResponse);
        }
      }
      return true;
    }
  );
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") {
      autoConnect();
    }
  });
  var DEBUG_FRAME_GONE = "\u76EE\u6807 iframe \u5DF2\u5BFC\u822A\u6216\u7ED3\u6784\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9";
  async function broadcastDebugSession(tabId, state, sendResponse) {
    const frames = await getFrameTree(tabId);
    for (const f of frames) {
      await sendToFrame(tabId, f.frameId, { type: "debug_mode", payload: { state } });
    }
    sendResponse({ ok: true });
  }
  async function broadcastDebugCommand(tabId, command, sendResponse) {
    const frames = await getFrameTree(tabId);
    let count = 0;
    for (const f of frames) {
      const { response } = await sendToFrame(tabId, f.frameId, {
        type: "execute_command",
        payload: { command, params: {} }
      });
      count += response?.data?.count ?? 0;
    }
    sendResponse({ success: true, data: { count } });
  }
  async function forwardDebugPick(tabId, type, payload, sourceFrameId, sendResponse) {
    if (sourceFrameId === 0) {
      sendResponse({ ok: true });
      return;
    }
    const { missing } = await sendToFrame(tabId, 0, { type, payload, sourceFrameId });
    sendResponse(missing ? { ok: false, error: "\u9876\u5C42\u8C03\u8BD5\u6D6E\u5C42\u4E0D\u53EF\u8FBE" } : { ok: true });
  }
  async function resolveFrameByChain(tabId, chain) {
    const urlOf = (e) => e && (e.url || e.src) || "";
    let current = 0;
    for (const hop of chain) {
      if (typeof hop?.index !== "number" || typeof hop?.url !== "string") {
        return { ok: false, error: DEBUG_FRAME_GONE };
      }
      const { response } = await sendToFrame(
        tabId,
        current,
        { type: "execute_command", payload: { command: "get_page_info", params: { _field: ["iframes"] } } },
        2e3
      );
      const list = response?.data?.iframes;
      if (!Array.isArray(list)) return { ok: false, error: DEBUG_FRAME_GONE };
      const matches = (e) => {
        const u = urlOf(e);
        return !!u && (u === hop.url || u.startsWith(hop.url));
      };
      const entry = matches(list[hop.index]) ? list[hop.index] : list.find(matches);
      if (!entry) return { ok: false, error: DEBUG_FRAME_GONE };
      const frames = await getFrameTree(tabId);
      const targetUrl = urlOf(entry);
      const child = frames.find((f) => f.parentFrameId === current && f.url && (f.url === targetUrl || f.url.startsWith(targetUrl)));
      if (!child) return { ok: false, error: DEBUG_FRAME_GONE };
      current = child.frameId;
    }
    return { ok: true, frameId: current };
  }
  async function runDebugExecute(tabId, payload, sendResponse) {
    const chain = Array.isArray(payload.chain) ? payload.chain : [];
    const resolved = await resolveFrameByChain(tabId, chain);
    if (!resolved.ok) {
      sendResponse({ success: false, error: resolved.error });
      return;
    }
    const { response, missing } = await sendToFrame(
      tabId,
      resolved.frameId,
      { type: "execute_command", payload: { command: payload.command, params: payload.params ?? {} } },
      1e4
    );
    if (missing) {
      sendResponse({ success: false, error: DEBUG_FRAME_GONE });
      return;
    }
    sendResponse(response ?? { success: false, error: "content script \u672A\u8FD4\u56DE\u7ED3\u679C" });
  }
  async function runDebugRealClick(tabId, x, y, chain, sendResponse) {
    let debugClickWarning;
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      try {
        debugClickWarning = await activateTabBounded(tabId);
        await settleAttachedViewport((method, p, timeoutMs) => cdpSend(tabId, method, p, timeoutMs), tabId);
        const clickPoint = { x, y, button: "left", clickCount: 1 };
        await withStepTimeout("move the mouse to the target", 15e3, moveMouseInSteps(tabId, x, y));
        await new Promise((r) => setTimeout(r, 120));
        await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...clickPoint });
        await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...clickPoint });
      } finally {
        await chrome.debugger.detach({ tabId }).catch(() => {
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      sendResponse({ success: false, error: `\u771F\u5B9E\u70B9\u51FB\u5931\u8D25: ${detail}${/already attached/i.test(detail) ? "\uFF08DevTools/\u5176\u4ED6\u8C03\u8BD5\u5668\u5DF2\u5360\u7528\uFF0C\u8BF7\u5148\u5173\u95ED\uFF09" : ""}` });
      return;
    }
    const chainArr = Array.isArray(chain) ? chain : [];
    const resolved = await resolveFrameByChain(tabId, chainArr);
    const settleFrameId = resolved.ok ? resolved.frameId : 0;
    const { response: settleResp, missing } = await sendToFrame(
      tabId,
      settleFrameId,
      { type: "execute_command", payload: { command: "wait_for_settle", params: { timeout: 3e3 } } },
      8e3
    );
    if (missing) {
      const tabNow = await chrome.tabs.get(tabId).catch(() => null);
      if (!tabNow) {
        sendResponse({ success: false, error: "\u70B9\u51FB\u540E\u6807\u7B7E\u9875\u5DF2\u5173\u95ED\uFF0C\u7ED3\u679C\u672A\u77E5" });
        return;
      }
      sendResponse({ success: true, data: { x, y, trusted: true, settleLost: true, ...debugClickWarning ? { warning: debugClickWarning } : {} } });
      return;
    }
    const settleInfo = settleResp?.data;
    sendResponse({
      success: true,
      data: {
        x,
        y,
        trusted: true,
        ...debugClickWarning ? { warning: debugClickWarning } : {},
        ...settleInfo ? { settled: settleInfo.settled, settledMs: settleInfo.settledMs } : {}
      }
    });
  }
  async function ensureAlarm() {
    const alarm = await chrome.alarms.get("keepalive");
    if (!alarm) {
      chrome.alarms.create("keepalive", { periodInMinutes: 15 / 60 });
    }
  }
  function applyFieldFilter(data, fields) {
    if (fields.length === 0) return data;
    if (data === null || typeof data !== "object") return data;
    if (Array.isArray(data)) {
      const out2 = [];
      for (const item of data) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        const obj = {};
        for (const f of fields) {
          const picked = pickPath(item, f.split(".").filter(Boolean));
          if (picked !== void 0) Object.assign(obj, picked);
        }
        if (Object.keys(obj).length > 0) out2.push(obj);
      }
      return out2;
    }
    const src = data;
    const out = {};
    const groups = /* @__PURE__ */ new Map();
    for (const f of fields) {
      const keys = f.split(".").filter(Boolean);
      if (!keys.length || !(keys[0] in src)) continue;
      const list = groups.get(keys[0]) ?? [];
      list.push(keys.slice(1));
      groups.set(keys[0], list);
    }
    for (const [root, paths] of groups) {
      if (paths.length === 1) {
        const picked = pickPath(src[root], paths[0]);
        if (picked !== void 0) out[root] = picked;
        continue;
      }
      const value = src[root];
      if (Array.isArray(value)) {
        const items = [];
        for (const item of value) {
          if (item === null || typeof item !== "object") continue;
          const obj = {};
          for (const p of paths) {
            const picked = pickPath(item, p);
            if (picked !== void 0) Object.assign(obj, picked);
          }
          if (Object.keys(obj).length > 0) items.push(obj);
        }
        out[root] = items;
      } else if (value !== null && typeof value === "object") {
        for (const p of paths) {
          const picked = pickPath(value, p);
          if (picked !== void 0) {
            out[root] = { ...out[root], ...picked };
          }
        }
      }
    }
    return out;
  }
  function pickPath(value, keys) {
    if (keys.length === 0) return value;
    const [k, ...rest] = keys;
    if (Array.isArray(value)) {
      const items = value.map((item) => item !== null && typeof item === "object" ? pickPath(item[k], rest) : void 0).filter((v) => v !== void 0);
      if (items.length === 0) return void 0;
      if (rest.length === 0) return items;
      return items.map((picked) => ({ [k]: picked }));
    }
    if (value !== null && typeof value === "object" && k in value) {
      const picked = pickPath(value[k], rest);
      if (picked === void 0) return void 0;
      return { [k]: picked };
    }
    return void 0;
  }
  var tabQueues = /* @__PURE__ */ new Map();
  function enqueueCommand(tabId, cmd, params) {
    const entry = tabQueues.get(tabId) || [];
    tabQueues.set(tabId, entry);
    entry.push({ cmd, params });
    if (entry.length === 1) {
      dequeueNext(tabId);
    }
  }
  function dequeueNext(tabId) {
    const entry = tabQueues.get(tabId);
    if (!entry || entry.length === 0) {
      tabQueues.delete(tabId);
      return;
    }
    const { cmd, params } = entry[0];
    sendToTab(tabId, cmd, params, () => {
      const e = tabQueues.get(tabId);
      if (e) {
        e.shift();
        dequeueNext(tabId);
      }
    });
  }
  async function sendToTab(tabId, cmd, params, onDone) {
    const command = cmd.payload.command;
    const isClick = command === "click";
    const fieldFilter = cmd.payload.params?._field || [];
    const needCurrent = fieldFilter.length === 0 || fieldFilter.some((f) => f === "currentTab" || f.startsWith("currentTab."));
    const needIframe = fieldFilter.length === 0 || fieldFilter.some((f) => f === "iframeChanges" || f.startsWith("iframeChanges."));
    const needNewTabs = fieldFilter.length === 0 || fieldFilter.some((f) => f === "newTabs" || f.startsWith("newTabs."));
    const needBeforeInfo = isClick && needIframe;
    const sendResult = (payload) => {
      wsClient.send({
        type: "command_result",
        payload: { ...payload, data: payload.success ? applyFieldFilter(payload.data, fieldFilter) : payload.data }
      });
    };
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      sendResult({ commandId: cmd.id, success: false, error: `Tab ${tabId} not found \u2014 was it closed?` });
      onDone?.();
      return;
    }
    let beforeTabs = [];
    let beforeFullInfo = null;
    if (needBeforeInfo || needNewTabs) {
      try {
        beforeTabs = await chrome.tabs.query({ windowId: tab.windowId });
      } catch {
      }
    }
    if (needBeforeInfo) {
      beforeFullInfo = await getFullPageInfo(tabId, cmd.payload.params, true);
    }
    const msg = { type: "execute_command", id: cmd.id, payload: { command, params } };
    if (command === "get_js_errors") {
      const data = await broadcastJsErrors(tabId);
      sendResult({ commandId: cmd.id, success: true, data });
      onDone?.();
      return;
    }
    if (command === "clear_js_errors") {
      await broadcastClearJsErrors(tabId);
      sendResult({ commandId: cmd.id, success: true, data: {} });
      onDone?.();
      return;
    }
    if (command === "hide") {
      const frames = await getFrameTree(tabId);
      let count = 0;
      for (const f of frames) {
        const { response: response2 } = await sendToFrame(tabId, f.frameId, msg);
        count += response2?.data?.count ?? 0;
      }
      sendResult({ commandId: cmd.id, success: true, data: { count } });
      onDone?.();
      return;
    }
    if (command === "get_page_info") {
      const info = await getFullPageInfo(tabId, params);
      sendResult({ commandId: cmd.id, success: info != null, data: info ?? void 0, error: info ? void 0 : "get_page_info failed" });
      onDone?.();
      return;
    }
    if (command === "list_elements") {
      const max = typeof params.max === "number" && Number.isFinite(params.max) ? Math.min(Math.max(1, Math.floor(params.max)), 200) : 50;
      const closed = params.closed === true;
      const csParams = { ...params };
      delete csParams.closed;
      const csMsg = { type: "execute_command", id: cmd.id, payload: { command, params: csParams } };
      const doCollect = async () => {
        const frames = await resolveSearchFrames(tabId, params.frame);
        const elements2 = [];
        let responded2 = false;
        for (const f of frames) {
          const { response: response2 } = await sendToFrame(tabId, f.frameId, csMsg, 5e3);
          if (response2) responded2 = true;
          const els = response2?.data?.elements;
          if (!Array.isArray(els)) continue;
          for (const e of els) elements2.push({ ...e, ...f.frameId !== 0 ? { frame: f.url } : {} });
        }
        return { elements: elements2, responded: responded2 };
      };
      let { elements, responded } = await doCollect();
      let injectError2;
      if (!responded) {
        try {
          await injectContentScript(tabId);
          ({ elements, responded } = await doCollect());
        } catch (e) {
          injectError2 = e instanceof Error ? e.message : String(e);
        }
      }
      let closedItems = [];
      let closedError;
      if (closed) {
        const filters = typeof params.filter === "string" ? params.filter.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
        try {
          closedItems = await withPiercedTree(tabId, (send, tree) => listClosedInteractive(send, tree, {
            filters,
            text: typeof params.text === "string" ? params.text : "",
            visibleOnly: params.visible === true,
            hiddenOnly: params.visible === false
          }));
        } catch (e) {
          closedError = cdpErrorCode(e) ? `${cdpErrorCode(e)}: ${e instanceof Error ? e.message : String(e)}` : e instanceof Error ? e.message : String(e);
        }
      }
      const all = closed ? [...closedItems, ...elements] : elements;
      const truncated = all.length > max;
      const kept = truncated ? all.slice(0, max) : all;
      const droppedClosed = closedItems.filter((it) => !kept.includes(it)).length;
      const warnings = [];
      if (injectError2 && !responded) warnings.push(`content script injection failed: ${injectError2}`);
      if (droppedClosed > 0) warnings.push(`${droppedClosed} closed-shadow element(s) were dropped by "max": ${max} \u2014 raise "max" to see them`);
      sendResult({
        commandId: cmd.id,
        success: true,
        data: {
          count: kept.length,
          truncated,
          total: all.length,
          elements: kept,
          ...warnings.length ? { warning: warnings.join("; ") } : {},
          ...closed ? { closedCount: closedItems.length } : {},
          ...closedError ? { closedError } : {}
        }
      });
      onDone?.();
      return;
    }
    if (command === "scroll") {
      const frames = await resolveSearchFrames(tabId, params.frame);
      const f = frames[0];
      if (!f) {
        sendResult({ commandId: cmd.id, success: false, error: "No matching frame for scroll" });
        onDone?.();
        return;
      }
      const { response: response2 } = await sendToFrame(tabId, f.frameId, msg, 1e4);
      if (!response2) {
        sendResult({ commandId: cmd.id, success: false, error: "Scroll timed out: no response from the target frame" });
        onDone?.();
        return;
      }
      sendResult({ commandId: cmd.id, success: response2?.success ?? false, data: response2?.data, error: response2?.error, code: response2?.code });
      onDone?.();
      return;
    }
    if (command === "get_viewport") {
      const frames = await resolveSearchFrames(tabId, params.frame);
      const f = frames[0];
      if (!f) {
        sendResult({ commandId: cmd.id, success: false, error: "No matching frame for get_viewport" });
        onDone?.();
        return;
      }
      const { response: response2 } = await sendToFrame(tabId, f.frameId, msg, 5e3);
      if (!response2) {
        sendResult({ commandId: cmd.id, success: false, error: "get_viewport timed out: no response from the target frame" });
        onDone?.();
        return;
      }
      sendResult({ commandId: cmd.id, success: response2.success, data: response2.data, error: response2.error, code: response2.code });
      onDone?.();
      return;
    }
    const isCoordinateClick = isClick && params.x !== void 0 && params.y !== void 0;
    const searchable = ELEMENT_SEARCH_COMMANDS.has(command) && !isCoordinateClick;
    const destructive = /* @__PURE__ */ new Set(["click", "type", "keyboard", "trigger", "upload_file", "upload_dragdrop", "paste_rich", "set_cursor"]);
    const isSlow = destructive.has(command);
    let response;
    let matchedFrame;
    let lostContact;
    let hadResponse = false;
    let injectError;
    async function doSearch() {
      if (!searchable) {
        const r = await sendToFrame(tabId, 0, msg, isSlow ? 1e4 : 1200);
        if (r.missing) {
          if (r.missing.reason !== "noreceiver") {
            lostContact = { frame: { frameId: 0, parentFrameId: -1, url: "", depth: 0, order: 0 }, reason: r.missing.reason };
          }
          return;
        }
        hadResponse = true;
        response = r.response;
        return;
      }
      const frames = await resolveSearchFrames(tabId, params.frame);
      for (const f of frames) {
        const r = await sendToFrame(tabId, f.frameId, msg, isSlow ? 1e4 : 1200);
        if (r.missing) {
          if (r.missing.reason === "noreceiver") continue;
          if (destructive.has(command)) {
            lostContact = { frame: f, reason: r.missing.reason };
            matchedFrame = f;
            return;
          }
          continue;
        }
        hadResponse = true;
        if (r.response?.notFound) continue;
        response = r.response;
        matchedFrame = f;
        return;
      }
    }
    const backendNodeId = typeof params.backendNodeId === "number" ? params.backendNodeId : void 0;
    if (backendNodeId !== void 0 && !isCoordinateClick) {
      const outcome = await byBackendNodeId(tabId, command, params);
      response = outcome.ok ? { success: true, data: outcome.data } : { success: false, error: outcome.error, code: outcome.code };
    }
    if (command === "get_rect" && params.selectors !== void 0 && backendNodeId === void 0) {
      const selectors = params.selectors;
      if (!Array.isArray(selectors) || selectors.some((s) => typeof s !== "string")) {
        sendResult({ commandId: cmd.id, success: false, error: '"selectors" must be an array of strings' });
        onDone?.();
        return;
      }
      if (params.selector !== void 0 || params.text !== void 0) {
        sendResult({ commandId: cmd.id, success: false, error: '"selectors" cannot be combined with "selector" or "text" \u2014 pass one or the other' });
        onDone?.();
        return;
      }
      const items = [];
      const needCdp = [];
      for (const [i, sel] of selectors.entries()) {
        const oneParams = { ...params, selector: sel };
        delete oneParams.selectors;
        const viaCs = await rectViaContentScript(tabId, oneParams);
        if (viaCs.data) items[i] = { selector: sel, ...viaCs.data };
        else needCdp.push({ key: String(i), params: oneParams });
      }
      if (needCdp.length) {
        const resolved = await resolveRectsViaCdp(tabId, needCdp);
        for (const q of needCdp) {
          const outcome = resolved.get(q.key);
          const sel = q.params.selector;
          items[Number(q.key)] = outcome?.ok ? { selector: sel, ...outcome.data } : { selector: sel, found: false, code: outcome?.code ?? ERR_NOT_FOUND, error: outcome?.error ?? `Element not found: ${sel}` };
        }
      }
      sendResult({ commandId: cmd.id, success: true, data: { count: items.length, items } });
      onDone?.();
      return;
    }
    if (!response) {
      await doSearch();
    }
    if (!response && !lostContact && !hadResponse) {
      try {
        await injectContentScript(tabId);
      } catch (e) {
        injectError = e instanceof Error ? e.message : String(e);
      }
      await doSearch();
    }
    if (response?.success && command === "get_rect" && params.all === true && typeof params.text === "string") {
      const alive = await chrome.tabs.get(tabId).then(() => true).catch(() => false);
      if (alive) {
        const outcome = (await resolveRectsViaCdp(tabId, [{ key: "0", params }])).get("0");
        const closed = (outcome?.ok ? outcome.data.allMatches : void 0)?.filter((m) => m.inClosedShadowRoot === true) ?? [];
        if (closed.length) {
          const data = response.data;
          const existing = Array.isArray(data.allMatches) ? data.allMatches : [];
          let priority = existing.filter((m) => typeof m.priority === "number").length;
          const merged = [
            ...existing,
            ...closed.map((m) => ({ ...m, ...m.visible ? { priority: priority++ } : {}, source: "cdp-pierced" }))
          ];
          const inPageCount = typeof data.matchCount === "number" ? data.matchCount : 0;
          response = {
            success: true,
            data: {
              ...data,
              allMatches: merged,
              matchCount: inPageCount + closed.length,
              // 两半来源不同，说清楚：页面内通道看不见闭包，闭包条目只能用 backendNodeId 下手
              matchCountNote: `${inPageCount} match(es) from the in-page channel + ${closed.length} from the CDP-pierced channel (closed shadow roots; use backendNodeId to act on those)`
            }
          };
        }
      }
    }
    if (!response && command === "get_rect" && hadResponse) {
      const alive = await chrome.tabs.get(tabId).then(() => true).catch(() => false);
      if (alive) {
        const outcome = (await resolveRectsViaCdp(tabId, [{ key: "0", params }])).get("0");
        if (outcome?.ok) {
          response = { success: true, data: outcome.data };
        } else if (outcome?.code) {
          response = { success: false, error: outcome.error, code: outcome.code };
        }
      }
    }
    if (!response && lostContact) {
      const beforeUrl = tab?.url || "";
      const verified = await verifyLostContact(tabId, lostContact, beforeUrl);
      const lostFrame = lostContact.frame;
      if (verified.state === "gone") {
        sendResult({ commandId: cmd.id, success: false, error: `Tab ${tabId} was closed while "${command}" was in flight \u2014 outcome unknown` });
        onDone?.();
        return;
      }
      if (verified.state === "dead") {
        sendResult({ commandId: cmd.id, success: false, error: `"${command}" was dispatched but its outcome could not be verified (content script unreachable in the tab)` });
        onDone?.();
        return;
      }
      if (verified.state === "navigated") {
        const navResult = { navigated: true, settleLost: true };
        if (needCurrent) {
          navResult.currentTab = await getFullPageInfo(tabId, cmd.payload.params);
        }
        if (needNewTabs) {
          try {
            const newTabInfos = await collectNewTabs(tabId, beforeTabs, cmd.payload.params);
            if (newTabInfos.length > 0) navResult.newTabs = newTabInfos;
          } catch {
          }
        }
        sendResult({ commandId: cmd.id, success: true, data: navResult });
        onDone?.();
        return;
      }
      if (isClick) {
        const afterInfo = needCurrent || needIframe ? await getFullPageInfo(tabId, cmd.payload.params, true) : null;
        const afterUrl = afterInfo?.url || "";
        const result = {
          navigated: false,
          settleLost: true,
          ...lostFrame.url ? { frame: { frameId: lostFrame.frameId, url: lostFrame.url } } : {}
        };
        if (afterUrl && beforeUrl && afterUrl !== beforeUrl) result.navigated = true;
        if (needCurrent) result.currentTab = afterInfo;
        if (needIframe) {
          const beforeIframes = beforeFullInfo?.iframes ?? [];
          const afterIframes = afterInfo?.iframes ?? [];
          const iframeChanges = beforeIframes.length > 0 || afterIframes.length > 0 ? diffIframes(beforeIframes, afterIframes) : [];
          if (iframeChanges.length > 0) result.iframeChanges = iframeChanges;
        }
        if (needNewTabs) {
          try {
            const newTabInfos = await collectNewTabs(tabId, beforeTabs, cmd.payload.params);
            if (newTabInfos.length > 0) result.newTabs = newTabInfos;
          } catch {
          }
        }
        sendResult({ commandId: cmd.id, success: true, data: result });
        onDone?.();
        return;
      }
      sendResult({
        commandId: cmd.id,
        success: true,
        data: { settleLost: true, ...lostFrame.url ? { frame: { frameId: lostFrame.frameId, url: lostFrame.url } } : {} }
      });
      onDone?.();
      return;
    }
    if (!response) {
      const tabAlive = await chrome.tabs.get(tabId).then(() => true).catch(() => false);
      const searchParams = params;
      const targetDesc = typeof searchParams.selector === "string" ? `selector: ${searchParams.selector}` : typeof searchParams.text === "string" ? `text: ${searchParams.text}` : "";
      const targetSuffix = targetDesc ? ` (${targetDesc})` : "";
      response = {
        success: false,
        // 错误码：与「元素存在但不可达」区分开，脚本能按类别分支，不必去猜文案
        code: !tabAlive ? void 0 : hadResponse ? ERR_NOT_FOUND : void 0,
        error: !tabAlive ? `Tab ${tabId} not found \u2014 was it closed?` : hadResponse ? `Element not found: no match in any frame${targetSuffix}${NOT_FOUND_HINT}` : !searchable ? "Click could not be delivered: no content script response (page still loading, frame navigated, or the page is restricted)" : injectError ? `No content script response from any frame; content script injection failed: ${injectError}` : "No content script response from any frame (page still loading or restricted)"
      };
    }
    const frameAttribution = matchedFrame ? { frame: { frameId: matchedFrame.frameId, url: matchedFrame.url } } : {};
    try {
      const wasNavigated = response?.data?.navigated === true;
      if (wasNavigated) {
        const currentInfo = needCurrent ? await getFullPageInfo(tabId, cmd.payload.params) : null;
        const navResult = { navigated: true };
        if (needCurrent) navResult.currentTab = currentInfo;
        if (needNewTabs) {
          try {
            const newTabInfos = await collectNewTabs(tabId, beforeTabs, cmd.payload.params);
            if (newTabInfos.length > 0) navResult.newTabs = newTabInfos;
          } catch {
          }
        }
        sendResult({ commandId: cmd.id, success: true, data: navResult });
        onDone?.();
        return;
      }
      if (isClick) {
        const afterInfo = needCurrent || needIframe ? await getFullPageInfo(tabId, cmd.payload.params, true) : null;
        let newTabInfos = [];
        if (needNewTabs) {
          try {
            newTabInfos = await collectNewTabs(tabId, beforeTabs, cmd.payload.params);
          } catch {
          }
        }
        const result = {
          navigated: false,
          ...typeof response?.data === "object" && response?.data !== null ? response.data : {},
          ...frameAttribution
        };
        if (result.navigated !== true && tab?.url && afterInfo?.url && afterInfo.url !== tab.url) {
          result.navigated = true;
        }
        if (needCurrent) result.currentTab = afterInfo;
        if (needIframe) {
          const iframeChanges = beforeFullInfo && afterInfo ? diffIframes(beforeFullInfo.iframes, afterInfo.iframes) : [];
          if (iframeChanges.length > 0) result.iframeChanges = iframeChanges;
        }
        if (needNewTabs && newTabInfos.length > 0) result.newTabs = newTabInfos;
        sendResult({ commandId: cmd.id, success: response?.success ?? false, data: result, error: response?.error, code: response?.code });
        onDone?.();
        return;
      }
      const dataIsPlainObj = typeof response?.data === "object" && response?.data !== null && !Array.isArray(response.data);
      const skipFrameMerge = command === "get_prop" && dataIsPlainObj && "frame" in response.data;
      const data = dataIsPlainObj ? { ...response.data, ...skipFrameMerge ? {} : frameAttribution } : response?.data;
      sendResult({ commandId: cmd.id, success: response?.success ?? false, data, error: response?.error, code: response?.code });
      onDone?.();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      sendResult({ commandId: cmd.id, success: false, error: `Unexpected error while running "${command}": ${detail} (please report this to cda)` });
      onDone?.();
    }
  }
  async function collectNewTabs(tabId, beforeTabs, cmdParams) {
    const beforeIds = new Set(beforeTabs.map((t) => t.id));
    try {
      const currentTab = await chrome.tabs.get(tabId);
      const afterTabs = await chrome.tabs.query({ windowId: currentTab.windowId });
      const newTabIds = afterTabs.filter((t) => t.id != null && !beforeIds.has(t.id)).map((t) => t.id);
      const out = [];
      for (const ntid of newTabIds) {
        try {
          await waitForTabLoad(ntid);
        } catch {
          continue;
        }
        const info = await getFullPageInfo(ntid, cmdParams);
        if (info) out.push({ tabId: ntid, ...info });
      }
      return out;
    } catch {
      return [];
    }
  }
  var ELEMENT_SEARCH_COMMANDS = /* @__PURE__ */ new Set(["click", "type", "keyboard", "get_text", "show", "upload_file", "upload_dragdrop", "paste_rich", "get_rect", "get_prop", "trigger", "set_cursor", "get_cursor"]);
  var frameTreeCache = /* @__PURE__ */ new Map();
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "complete") frameTreeCache.delete(tabId);
  });
  async function getFrameTree(tabId) {
    const cached = frameTreeCache.get(tabId);
    if (cached && Date.now() - cached.at < 500) return cached.frames;
    let frames = [];
    try {
      const all = await chrome.webNavigation.getAllFrames({ tabId });
      if (all && all.length > 0) {
        const byId = new Map(all.map((f) => [f.frameId, f]));
        const depthOf = /* @__PURE__ */ new Map();
        const depth = (frameId) => {
          const cachedD = depthOf.get(frameId);
          if (cachedD != null) return cachedD;
          const f = byId.get(frameId);
          const d = f && f.parentFrameId != null && f.parentFrameId !== -1 ? depth(f.parentFrameId) + 1 : 0;
          depthOf.set(frameId, d);
          return d;
        };
        frames = all.map((f, i) => ({
          frameId: f.frameId,
          parentFrameId: f.parentFrameId ?? -1,
          url: f.url || "",
          depth: depth(f.frameId),
          order: i
        })).sort((a, b) => a.depth - b.depth || a.order - b.order);
      }
    } catch {
    }
    if (frames.length === 0) {
      frames = [{ frameId: 0, parentFrameId: -1, url: "", depth: 0, order: 0 }];
    }
    frameTreeCache.set(tabId, { at: Date.now(), frames });
    return frames;
  }
  function sendToFrame(tabId, frameId, msg, timeoutMs = 1200) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ missing: { reason: "timeout" } }), timeoutMs);
      try {
        chrome.tabs.sendMessage(tabId, msg, { frameId }, (r) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            const text = String(chrome.runtime.lastError.message || "");
            const reason = /Receiving end does not exist|Could not establish connection/i.test(text) ? "noreceiver" : "portclosed";
            resolve({ missing: { reason } });
            return;
          }
          resolve({ response: r });
        });
      } catch {
        clearTimeout(timer);
        resolve({ missing: { reason: "portclosed" } });
      }
    });
  }
  async function verifyLostContact(tabId, lost, beforeUrl) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { state: "gone" };
    const frames = await getFrameTree(tabId);
    const now = frames.find((f) => f.frameId === lost.frame.frameId);
    const topUrl = tab.url || "";
    const isTop = lost.frame.frameId === 0;
    const before = isTop ? lost.frame.url || beforeUrl : lost.frame.url;
    if (before && topUrl && topUrl !== before) return { state: "navigated" };
    if (!isTop && !now) return { state: "navigated" };
    if (now && now.url && lost.frame.url && now.url !== lost.frame.url) return { state: "navigated" };
    let alive = false;
    for (let i = 0; i < 4 && !alive; i++) {
      if (i === 1) {
        try {
          await injectContentScript(tabId);
        } catch {
        }
      }
      const probe = await sendToFrame(tabId, lost.frame.frameId, {
        type: "execute_command",
        payload: { command: "get_js_errors", params: {} }
      }, 1500);
      alive = !!probe.response;
      if (!alive) await new Promise((r) => setTimeout(r, 300));
    }
    return alive ? { state: "alive" } : { state: "dead" };
  }
  async function getTopIframes(tabId) {
    const { response } = await sendToFrame(tabId, 0, {
      type: "execute_command",
      payload: { command: "get_page_info", params: { _field: ["iframes"] } }
    });
    return response?.data?.iframes ?? [];
  }
  async function resolveSearchFrames(tabId, frameParam) {
    const frames = await getFrameTree(tabId);
    if (frameParam === "top") return frames.filter((f) => f.frameId === 0);
    if (typeof frameParam === "number") {
      const iframes = await getTopIframes(tabId);
      const target = iframes[frameParam];
      const src = target?.url || target?.src;
      if (!src) return [];
      const hit = frames.find((f) => f.parentFrameId === 0 && f.url && (f.url === src || f.url.startsWith(src)));
      return hit ? [hit] : [];
    }
    if (frameParam && typeof frameParam === "object" && !Array.isArray(frameParam)) {
      const urlSub = frameParam.url;
      if (urlSub) {
        const hit = frames.find((f) => f.url && f.url.includes(urlSub));
        return hit ? [hit] : [];
      }
    }
    return frames;
  }
  async function enrichCrossOriginIframes(tabId, iframes, needHtml) {
    if (!iframes.some((f) => !f.sameOrigin)) return iframes;
    const frames = await getFrameTree(tabId);
    const childFrames = frames.filter((f) => f.parentFrameId === 0);
    const used = /* @__PURE__ */ new Set();
    const out = [];
    for (const ifr of iframes) {
      if (ifr.sameOrigin) {
        out.push(ifr);
        continue;
      }
      let match = childFrames.find((cf) => !used.has(cf.frameId) && ifr.src && cf.url && (cf.url === ifr.src || cf.url.startsWith(ifr.src)));
      if (!match) match = childFrames.find((cf) => !used.has(cf.frameId));
      if (match) {
        used.add(match.frameId);
        const { response } = await sendToFrame(tabId, match.frameId, {
          type: "execute_command",
          payload: { command: "frame_info", params: {} }
        });
        const d = response?.data;
        out.push({
          index: ifr.index,
          src: ifr.src,
          sameOrigin: false,
          ...d?.url ? { url: d.url } : {},
          ...needHtml && d?.html ? { html: d.html } : {}
        });
      } else {
        out.push(ifr);
      }
    }
    return out;
  }
  async function broadcastJsErrors(tabId) {
    const frames = await getFrameTree(tabId);
    const errors = [];
    for (const f of frames) {
      const { response } = await sendToFrame(tabId, f.frameId, {
        type: "execute_command",
        payload: { command: "get_js_errors", params: {} }
      });
      const errs = response?.data?.errors;
      if (Array.isArray(errs)) {
        for (const e of errs) errors.push({ ...e, ...f.frameId !== 0 ? { frame: f.url } : {} });
      }
    }
    return { errors, count: errors.length };
  }
  async function broadcastClearJsErrors(tabId) {
    const frames = await getFrameTree(tabId);
    for (const f of frames) {
      await sendToFrame(tabId, f.frameId, {
        type: "execute_command",
        payload: { command: "clear_js_errors", params: {} }
      });
    }
  }
  async function getFullPageInfo(tabId, cmdParams, forDiff = false) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status !== "complete" || !tab.url) {
        await waitForTabLoad(tabId);
      }
      const t = await chrome.tabs.get(tabId);
      const result = {
        url: t.url || "",
        title: t.title || "",
        iframes: []
      };
      const fields = cmdParams?._field || [];
      const mappedFields = fields.map((f) => f.replace(/^currentTab\./, ""));
      const needContentScript = forDiff || fields.length === 0 || mappedFields.some((f) => f === "iframes" || f === "html" || f === "jsErrors");
      const needIframes = forDiff || fields.length === 0 || fields.some((f) => f === "iframes" || f === `currentTab.iframes`);
      const needHtml = !forDiff && fields.some((f) => f === "html" || f === `currentTab.html`);
      const csFields = forDiff ? ["iframes"] : fields.length === 0 ? ["iframes"] : mappedFields;
      if (needContentScript) {
        await waitForTabLoad(tabId);
        let iframes = null;
        let html;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 100));
          const { response } = await sendToFrame(tabId, 0, {
            type: "execute_command",
            payload: { command: "get_page_info", params: { _field: csFields } }
          });
          const data = response?.data;
          if (typeof data?.html === "string") html = data.html;
          if (data?.iframes && data.iframes.length > 0) iframes = data.iframes;
          if ((!needIframes || iframes) && (!needHtml || html !== void 0)) break;
        }
        if (iframes) {
          result.iframes = await enrichCrossOriginIframes(tabId, iframes, needIframes);
        }
        if (needHtml && html !== void 0) result.html = html;
      }
      if (!forDiff && (fields.length === 0 || mappedFields.some((f) => f === "jsErrors"))) {
        const { errors } = await broadcastJsErrors(tabId);
        result.jsErrors = errors;
      }
      return result;
    } catch {
      return null;
    }
  }
  function diffIframes(before, after) {
    const beforeMap = new Map(before.map((f) => [f.index, f]));
    const afterMap = new Map(after.map((f) => [f.index, f]));
    const changes = [];
    const allIndices = /* @__PURE__ */ new Set([...beforeMap.keys(), ...afterMap.keys()]);
    for (const idx of allIndices) {
      const b = beforeMap.get(idx);
      const a = afterMap.get(idx);
      if (!b && a) {
        changes.push({ index: idx, srcChanged: true, beforeSrc: "", afterSrc: a.src });
      } else if (b && !a) {
        changes.push({ index: idx, srcChanged: true, beforeSrc: b.src, afterSrc: "" });
      } else if (b && a) {
        const srcChanged = b.src !== a.src;
        if (srcChanged) {
          changes.push({ index: idx, srcChanged, beforeSrc: b.src, afterSrc: a.src });
        }
      }
    }
    return changes;
  }
  function waitForTabLoad(tabId, timeoutMs = 3e4) {
    return new Promise((resolve, reject) => {
      chrome.tabs.get(tabId, (tab) => {
        if (tab.status === "complete" && tab.url) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error(`Tab ${tabId} load timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const listener = (tid, info) => {
          if (tid === tabId && info.status === "complete") {
            chrome.tabs.get(tabId, (t) => {
              if (t.url) {
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            });
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    });
  }
  function resolveTabId(raw) {
    if (typeof raw === "number") return Number.isInteger(raw) ? raw : void 0;
    if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
    return void 0;
  }
  async function injectContentScript(tabId) {
    const INJECT_TIMEOUT = 5e3;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error(`Content script injection timed out after ${INJECT_TIMEOUT}ms`));
      }, INJECT_TIMEOUT);
      const listener = (_msg) => {
        if (_msg.type === "cs_injected") {
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          resolve();
        }
      };
      chrome.runtime.onMessage.addListener(listener);
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content/content-script.js"]
    });
    await ready;
  }
  async function getOrCreateGroup(windowId) {
    if (groupId != null && groupWindowId === windowId) {
      try {
        await chrome.tabGroups.get(groupId);
        return groupId;
      } catch {
        groupId = null;
        groupWindowId = null;
      }
    }
    const existing = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
    if (existing.length > 0) {
      groupId = existing[0].id;
      groupWindowId = windowId;
      return groupId;
    }
    return null;
  }
  async function cleanupGroupIfEmpty() {
    if (groupId == null || groupWindowId == null) return;
    try {
      const tabs = await chrome.tabs.query({ groupId });
      if (tabs.length === 0) {
        groupId = null;
        groupWindowId = null;
      }
    } catch {
    }
  }
  chrome.tabGroups.onRemoved.addListener((group) => {
    if (group.id === groupId) {
      groupId = null;
      groupWindowId = null;
    }
  });
  var EXEC_DISABLED_ERROR = "exec \u547D\u4EE4\u4EC5\u7528\u4E8E\u6392\u67E5\u95EE\u9898\uFF0C\u672A\u5728\u63D2\u4EF6\u914D\u7F6E\u4E2D\u542F\u7528\uFF1A\u8BF7\u5728\u63D2\u4EF6\u914D\u7F6E\u9875\uFF08\u70B9\u6269\u5C55\u56FE\u6807 \u2192\u300C\u6253\u5F00\u914D\u7F6E\u9875\u300D\uFF09\u52FE\u9009\u300C\u5141\u8BB8 exec \u547D\u4EE4\uFF08\u4EC5\u6392\u67E5\u95EE\u9898\uFF09\u300D\u540E\u518D\u8BD5\uFF0C\u6392\u67E5\u5B8C\u8BF7\u53CA\u65F6\u5173\u95ED";
  async function execEvalInMainWorld(code) {
    try {
      let value = (0, eval)(code);
      if (value !== null && typeof value === "object" && typeof value.then === "function") {
        value = await value;
      }
      JSON.stringify(value);
      return { ok: true, value: value === void 0 ? null : value };
    } catch (err) {
      const detail = err instanceof Error ? err : new Error(String(err));
      const stack = detail.stack ? `
${detail.stack.split("\n").slice(0, 4).join("\n")}` : "";
      return { ok: false, error: `${detail.name}: ${detail.message}${stack}` };
    }
  }
  async function handleExecCommand(cmd) {
    const params = cmd.payload.params ?? {};
    const fieldFilter = params._field || [];
    function sendResult(payload) {
      wsClient.send({
        type: "command_result",
        payload: { commandId: cmd.id, ...payload, data: payload.success ? applyFieldFilter(payload.data, fieldFilter) : payload.data }
      });
    }
    const stored = await chrome.storage.local.get("allowExec").catch(() => ({}));
    if (!stored.allowExec) {
      sendResult({ success: false, error: EXEC_DISABLED_ERROR });
      return;
    }
    const code = params.code;
    if (typeof code !== "string" || !code.trim()) {
      sendResult({ success: false, error: 'exec needs a non-empty "code" string parameter (e.g. {"code":"document.title"})' });
      return;
    }
    let tabId = params.tabId;
    if (tabId == null) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tabs[0]?.id;
      if (tabId == null) {
        sendResult({ success: false, error: "No active tab" });
        return;
      }
    }
    const frames = await resolveSearchFrames(tabId, params.frame);
    const target = frames[0];
    if (!target) {
      sendResult({ success: false, error: `No matching frame for exec${params.frame !== void 0 ? ` (frame: ${JSON.stringify(params.frame)})` : ""}` });
      return;
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: target.frameId === 0 ? { tabId } : { tabId, frameIds: [target.frameId] },
        world: "MAIN",
        func: execEvalInMainWorld,
        args: [code]
      });
      const out = results?.[0]?.result;
      if (out?.ok) {
        sendResult({ success: true, data: out.value });
      } else {
        sendResult({ success: false, error: out?.error || "exec returned no result" });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const hint = /chrome:|web store|new tab|settings/i.test(detail) ? "\uFF08Chrome \u5185\u5EFA\u9875\u3001\u6269\u5C55\u5546\u5E97\u7B49\u53D7\u9650\u9875\u9762\u65E0\u6CD5\u6CE8\u5165\u4EE3\u7801\uFF09" : "";
      sendResult({ success: false, error: `exec \u6CE8\u5165\u6267\u884C\u5931\u8D25: ${detail}${hint}` });
    }
  }
  async function handleBrowserCommand(cmd) {
    const { command, params = {} } = cmd.payload;
    const fieldFilter = params._field || [];
    function sendResult(payload) {
      wsClient.send({
        type: "command_result",
        payload: { ...payload, data: payload.success ? applyFieldFilter(payload.data, fieldFilter) : payload.data }
      });
    }
    try {
      switch (command) {
        case "open": {
          const url = params.url;
          if (typeof url !== "string" || !url) {
            sendResult({ commandId: cmd.id, success: false, error: 'open needs a "url" parameter' });
            return;
          }
          const tab = await chrome.tabs.create({ url });
          const gid = await getOrCreateGroup(tab.windowId);
          if (gid == null) {
            groupId = await chrome.tabs.group({ tabIds: [tab.id] });
            groupWindowId = tab.windowId;
            await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "grey" });
          } else {
            await chrome.tabs.group({ tabIds: tab.id, groupId: gid });
          }
          const fullInfo = await getFullPageInfo(tab.id, params);
          sendResult({
            commandId: cmd.id,
            success: true,
            data: fullInfo
          });
          break;
        }
        case "list_tabs": {
          const tabs = await chrome.tabs.query({});
          sendResult({
            commandId: cmd.id,
            success: true,
            data: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }))
          });
          break;
        }
        case "refresh": {
          let tabId;
          if (params.tabId === "current") {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tabs[0]?.id;
            if (tabId == null) {
              sendResult({ commandId: cmd.id, success: false, error: "No active tab" });
              return;
            }
          } else {
            tabId = resolveTabId(params.tabId);
          }
          if (tabId == null) {
            sendResult({ commandId: cmd.id, success: false, error: "Missing tabId parameter" });
            return;
          }
          await chrome.tabs.reload(tabId);
          await waitForTabLoad(tabId);
          sendResult({ commandId: cmd.id, success: true });
          break;
        }
        case "close_tab": {
          let tabId;
          if (params.tabId === "current") {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tabs[0]?.id;
            if (tabId == null) {
              sendResult({ commandId: cmd.id, success: false, error: "No active tab" });
              return;
            }
          } else {
            tabId = resolveTabId(params.tabId);
          }
          if (tabId == null) {
            sendResult({ commandId: cmd.id, success: false, error: "Missing tabId parameter" });
            return;
          }
          const queue = tabQueues.get(tabId);
          if (queue) {
            for (const queued of queue.slice(1)) {
              wsClient.send({
                type: "command_result",
                payload: { commandId: queued.cmd.id, success: false, error: `Tab ${tabId} was closed before this command ran (queued command cancelled)` }
              });
            }
            tabQueues.delete(tabId);
          }
          await chrome.tabs.remove(tabId);
          cleanupGroupIfEmpty();
          sendResult({ commandId: cmd.id, success: true, data: { tabId } });
          break;
        }
        default:
          sendResult({ commandId: cmd.id, success: false, error: `Unknown browser command: ${command}` });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      wsClient.send({
        type: "command_result",
        payload: { commandId: cmd.id, success: false, error: `Unexpected error while running "${cmd.payload.command}": ${detail} (please report this to cda)` }
      });
    }
  }
  async function autoConnect() {
    if (wsClient.getStatus() === "connected" || wsClient.getStatus() === "connecting") {
      return;
    }
    const manual = await chrome.storage.session.get("manualDisconnect").catch(() => ({}));
    if (manual.manualDisconnect) return;
    const retry = wsClient.getRetryState();
    if (retry.nextRetryAt && retry.nextRetryAt > Date.now()) {
      return;
    }
    const result = await chrome.storage.local.get(["nodeName", "serverUrl", "autoConnect"]);
    const config = result;
    if (config.autoConnect && config.serverUrl && config.nodeName) {
      wsClient.connect(config.serverUrl, config.nodeName);
    }
  }
  function pngSize(base64) {
    try {
      const head = atob(base64.slice(0, 64));
      if (head.slice(0, 8) !== "\x89PNG\r\n\n") return null;
      if (head.slice(12, 16) !== "IHDR") return null;
      const be32 = (o) => (head.charCodeAt(o) << 24 | head.charCodeAt(o + 1) << 16 | head.charCodeAt(o + 2) << 8 | head.charCodeAt(o + 3)) >>> 0;
      return { w: be32(16), h: be32(20) };
    } catch {
      return null;
    }
  }
  async function handleRealClick(cmd) {
    const params = cmd.payload.params || {};
    let tabId = params.tabId;
    const selector = params.selector;
    const approach = params.approach;
    const fieldFilter = params._field || [];
    function sendResult(payload) {
      wsClient.send({
        type: "command_result",
        payload: { commandId: cmd.id, ...payload, data: payload.success ? applyFieldFilter(payload.data, fieldFilter) : payload.data }
      });
    }
    try {
      if (tabId == null) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tid = tabs[0]?.id;
        if (tid == null) {
          sendResult({ success: false, error: "No active tab" });
          return;
        }
        tabId = tid;
      }
      if (cmd.payload.command === "screenshot") {
        await chrome.debugger.attach({ tabId }, "1.3");
        try {
          const send2 = (method, p, timeoutMs) => cdpSend(tabId, method, p, timeoutMs);
          await settleAttachedViewport(send2, tabId);
          const result = await cdpSend(tabId, "Page.captureScreenshot", {
            format: "png"
          });
          const base64 = result?.data ?? "";
          const measured = await viewportFacts(send2);
          const imagePx = pngSize(base64);
          const warnings = [];
          if (!imagePx) warnings.push("could not read the PNG header \u2014 imagePx unknown, do NOT convert image coordinates to CSS");
          const dpr = measured.dpr;
          const viewportCss = imagePx ? { w: imagePx.w / dpr, h: imagePx.h / dpr } : measured.viewportCss;
          if (imagePx) {
            if (Math.abs(viewportCss.w - measured.viewportCss.w) > 1) {
              warnings.push(`the captured image is ${viewportCss.w} CSS px wide but the viewport measured ${measured.viewportCss.w} \u2014 the page layout changed during capture, so the 1:1 image\u2194viewport mapping is NOT verified for this shot, do NOT use image\u2192CSS conversion here`);
            }
            if (Math.abs(viewportCss.h - measured.viewportCss.h) > 1) {
              warnings.push(`the captured image is ${viewportCss.h} CSS px tall but the viewport measured ${measured.viewportCss.h} \u2014 the page layout changed during capture (the debugger infobar animates), re-capture if exact height matters`);
            }
          }
          sendResult({
            success: true,
            data: {
              data: base64,
              // CLI 拆包写盘用，不打印（几 MB 的 base64 不该进终端）
              ...imagePx ? { imagePx } : {},
              viewportCss,
              dpr,
              // imagePx.w / dpr === viewportCss.w 由构造恒成立（viewportCss 就是从 imagePx 反推的）
              scale: dpr,
              chromeInsetCss: { top: 0, left: 0 },
              scrollCss: measured.scrollCss,
              // 这一条是本次拍照所依据的视口（附加态）。它与 get_viewport 报的（无 debugger 态）
              // 可能差一个信息条的高度：底部锚定 / 垂直居中 / vh 类元素在两者里位置不同，
              // 换算出来的坐标要配 real_click（同样附加 debugger）用，不要配页面内 click {x,y}
              viewportSource: "measured while the debugger was attached (what this image covers); get_viewport reports the viewport without a debugger attached \u2014 the two differ by the debugger infobar height when they differ at all",
              mapping: "css = image / dpr \u2014 image (0,0) is the viewport's top-left corner (the screenshot contains no browser UI: no infobar, no tabs)",
              ...warnings.length ? { warning: warnings.join("; ") } : {}
            }
          });
        } finally {
          await chrome.debugger.detach({ tabId }).catch(() => {
          });
        }
        return;
      }
      const backendNodeId = typeof params.backendNodeId === "number" ? params.backendNodeId : void 0;
      if (params.x == null && params.y == null && !selector && !params.text && backendNodeId === void 0) {
        sendResult({ success: false, error: 'real_click needs "selector", "text", {x, y}, or {backendNodeId}' });
        return;
      }
      if (params.x == null !== (params.y == null)) {
        const given = params.x == null ? "y" : "x";
        sendResult({
          success: false,
          error: `real_click needs both "x" and "y" \u2014 got only "${given}". Pass {x, y} together, or use selector/text/backendNodeId instead.`
        });
        return;
      }
      let x = params.x;
      let y = params.y;
      let cdpFrameId;
      let hitFrame;
      let coordsFromInPage = false;
      if (backendNodeId !== void 0) {
      } else if (x == null || y == null) {
        const frames = await resolveSearchFrames(tabId, params.frame);
        for (const f of frames) {
          const r = await sendToFrame(tabId, f.frameId, {
            type: "execute_command",
            payload: { command: "get_rect", params: { selector, text: params.text, scroll: true } }
          }, 8e3);
          if (r.missing || r.response?.notFound) continue;
          const d = r.response?.data;
          if (d?.crossOrigin) {
            cdpFrameId = f.frameId;
            hitFrame = f;
            break;
          }
          x = d?.x;
          y = d?.y;
          coordsFromInPage = true;
          hitFrame = f;
          break;
        }
      }
      if ((x == null || y == null) && backendNodeId === void 0) {
        sendResult({ success: false, error: `Could not locate element: ${selector || params.text || "unknown"}` });
        return;
      }
      const send = (method, p, timeoutMs) => cdpSend(tabId, method, p, timeoutMs);
      let pierced;
      let piercedError;
      let hitDesc;
      let hitUnavailable;
      let urlBeforeClick = "";
      const clickWarnings = [];
      await chrome.debugger.attach({ tabId }, "1.3");
      try {
        try {
          await withStepTimeout("enable DOM/Runtime domains", 12e3, enableDomains(send));
          await withStepTimeout("settle the attached viewport", 15e3, settleAttachedViewport(send, tabId));
          pierced = await withStepTimeout("read the pierced DOM", 12e3, readPiercedTree(send));
        } catch (e) {
          piercedError = e instanceof Error ? e.message : String(e);
        }
        if (coordsFromInPage && hitFrame) {
          const r = await sendToFrame(tabId, hitFrame.frameId, {
            type: "execute_command",
            payload: { command: "get_rect", params: { selector, text: params.text, scroll: true } }
          }, 8e3);
          const d = r.response?.data;
          if (typeof d?.x === "number" && typeof d?.y === "number") {
            x = d.x;
            y = d.y;
          }
        }
        if (backendNodeId !== void 0) {
          if (!pierced) {
            sendResult({ success: false, code: ERR_CDP, error: `Cannot resolve backendNodeId ${backendNodeId}: the pierced DOM is unavailable (${piercedError || "unknown"})` });
            return;
          }
          await withStepTimeout(`scroll backendNodeId ${backendNodeId} into view`, 12e3, scrollIntoView(send, backendNodeId));
          const box = await withStepTimeout(`measure backendNodeId ${backendNodeId}`, 12e3, boxOf(send, backendNodeId));
          if (!box) {
            const known = pierced.byBackendId.has(backendNodeId);
            sendResult({
              success: false,
              code: known ? ERR_UNREACHABLE : ERR_NOT_FOUND,
              error: known ? `backendNodeId ${backendNodeId} is in the page but has no usable geometry (zero-size or hidden) \u2014 it cannot be used as a click target. Make it visible first (e.g. open the menu that renders it), then re-run list_elements {"closed":true} and use the fresh id.` : `backendNodeId ${backendNodeId} is no longer in the page (ids change whenever the page re-renders, reloads, or the element is replaced) \u2014 re-run list_elements {"closed":true} and use a fresh id.`
            });
            return;
          }
          x = box.centerCss.x;
          y = box.centerCss.y;
          const facts = await withStepTimeout(`describe backendNodeId ${backendNodeId}`, 12e3, describeBackendNode(send, pierced, backendNodeId));
          if (facts?.frameUrl) {
            const frames = await withStepTimeout("resolve the frame tree", 5e3, resolveSearchFrames(tabId, void 0));
            hitFrame = frames.find((f) => f.url === facts.frameUrl);
          }
        } else if (cdpFrameId != null) {
          const point = await getElementCenterViaCdp(tabId, cdpFrameId, params);
          if (!point) {
            sendResult({ success: false, error: `Could not locate element in iframe via CDP: ${selector}` });
            return;
          }
          x = point.x;
          y = point.y;
        }
        if (x == null || y == null) {
          sendResult({
            success: false,
            code: ERR_UNREACHABLE,
            error: `No usable click point for ${selector || params.text || `backendNodeId ${backendNodeId}`}`
          });
          return;
        }
        const clickViewport = await viewportFacts(send);
        const vw = clickViewport.viewportCss.w;
        const vh = clickViewport.viewportCss.h;
        if (vw > 0 && vh > 0 && (x < 0 || y < 0 || x > vw || y > vh + INFOBAR_SLACK_CSS)) {
          sendResult({
            success: false,
            code: ERR_NOT_FOUND,
            error: `Click point (${Math.round(x)}, ${Math.round(y)}) is outside the page viewport (${clickViewport.viewportCss.w}\xD7${clickViewport.viewportCss.h} CSS px here) \u2014 nothing can receive a click there, so it was NOT dispatched. Scroll it into view first (get_rect {"scroll":true} returns coordinates that are clickable), or click by selector/text/backendNodeId so cda scrolls for you.`
          });
          return;
        }
        const activationIssue = await activateTabBounded(tabId);
        if (activationIssue) clickWarnings.push(activationIssue);
        const clickPoint = { x, y, button: "left", clickCount: 1 };
        urlBeforeClick = (await withStepTimeout("read the tab URL", 3e3, chrome.tabs.get(tabId)).catch(() => null))?.url || "";
        if (approach && approach.length) {
          for (const [ax, ay] of approach) {
            await moveMouseBounded(tabId, ax, ay, clickWarnings);
            await new Promise((r) => setTimeout(r, 150));
          }
        }
        await moveMouseBounded(tabId, x, y, clickWarnings);
        await new Promise((r) => setTimeout(r, approach && approach.length ? 400 : 120));
        if (pierced) {
          try {
            const hit = await withStepTimeout("hit-test the click point", 8e3, hitTestAt(send, pierced, x, y));
            if (hit) {
              hitDesc = toHitDescription(hit);
            } else {
              hitUnavailable = "nothing at that point (the coordinate is outside the page, or over a native control CDP does not report)";
            }
          } catch (e) {
            hitUnavailable = e instanceof Error ? e.message : String(e);
          }
        } else {
          hitUnavailable = `pierced DOM unavailable (${piercedError || "unknown"})`;
        }
        await cdpSend(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...clickPoint
        });
        await cdpSend(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...clickPoint
        });
      } finally {
        await chrome.debugger.detach({ tabId }).catch(() => {
        });
      }
      const settleFrameId = hitFrame ? hitFrame.frameId : 0;
      const beforeUrl = urlBeforeClick;
      const { response: settleResp, missing } = await sendToFrame(tabId, settleFrameId, {
        type: "execute_command",
        payload: { command: "wait_for_settle", params: { timeout: 3e3, wait_for: params.waitFor } }
      }, 8e3);
      const settleInfo = settleResp?.data;
      if (missing) {
        const tabNow = await withStepTimeout("read the tab", 3e3, chrome.tabs.get(tabId)).catch(() => null);
        if (!tabNow) {
          sendResult({ success: false, error: "Tab was closed during the real click \u2014 outcome unknown" });
          return;
        }
        const frames = await withStepTimeout("resolve the frame tree", 5e3, getFrameTree(tabId));
        const now = frames.find((f) => f.frameId === settleFrameId);
        const navigatedNow = !!beforeUrl && !!tabNow.url && tabNow.url !== beforeUrl || settleFrameId !== 0 && !now || !!now && !!hitFrame?.url && !!now.url && now.url !== hitFrame.url;
        if (navigatedNow) {
          sendResult({
            success: true,
            data: {
              x,
              y,
              trusted: true,
              settleLost: true,
              navigated: true,
              ...hitDesc ? { hit: hitDesc } : {},
              ...clickWarnings.length ? { warning: clickWarnings.join("; ") } : {},
              ...params.waitFor ? { waitFor: { settled: false, skipped: "page navigated after the click \u2014 condition not evaluated" } } : {}
            }
          });
          return;
        }
        if (params.waitFor) {
          sendResult({ success: false, error: "waitFor could not be verified: content script unresponsive after the real click (the click itself was dispatched)" });
          return;
        }
        sendResult({ success: true, data: { x, y, trusted: true, settleLost: true, ...hitDesc ? { hit: hitDesc } : {}, ...clickWarnings.length ? { warning: clickWarnings.join("; ") } : {} } });
        return;
      }
      const urlAfter = (await withStepTimeout("read the tab URL", 3e3, chrome.tabs.get(tabId)).catch(() => null))?.url || "";
      const navigated = !!beforeUrl && !!urlAfter && urlAfter !== beforeUrl;
      sendResult({
        success: true,
        data: {
          x,
          y,
          trusted: true,
          navigated,
          // 命中回执：点到的到底是谁。给错坐标时调用方可以在**造成后果之前**断言并中止
          ...hitDesc ? { hit: hitDesc } : {},
          // 回执缺失如实上报（CDP 不可用 / 坐标处无节点），不静默省略成"看起来没这功能"
          ...hitUnavailable ? { hitUnavailable } : {},
          // 链路里非致命但没按预期完成的步骤（窗口激活超时 / 鼠标轨迹没走完）
          ...clickWarnings.length ? { warning: clickWarnings.join("; ") } : {},
          ...backendNodeId !== void 0 ? { backendNodeId } : {},
          ...settleInfo ? { settledMs: settleInfo.settledMs, settled: settleInfo.settled, ...settleInfo.waitFor ? { waitFor: settleInfo.waitFor } : {} } : {}
        }
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      sendResult({ success: false, error: `Unexpected error while running "${cmd.payload.command}": ${detail} (please report this to cda)` });
    }
  }
  async function handleTrustedDrop(cmd) {
    const params = cmd.payload.params || {};
    let tabId = params.tabId;
    const selector = params.selector;
    const fieldFilter = params._field || [];
    function sendResult(payload) {
      wsClient.send({
        type: "command_result",
        payload: { commandId: cmd.id, ...payload, data: payload.success ? applyFieldFilter(payload.data, fieldFilter) : payload.data }
      });
    }
    const data = params.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      sendResult({ success: false, error: 'upload_dragdrop (trusted mode) needs "data": {"path": "/abs/path"}' });
      return;
    }
    const path = data.path;
    if (typeof path !== "string" || !path) {
      sendResult({
        success: false,
        error: 'upload_dragdrop (trusted mode) needs "data.path" \u2014 an absolute path to a file on the machine running Chrome. base64/url payloads belong to the synthetic (non-trusted) path: omit trusted:true for those'
      });
      return;
    }
    if (!(path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\"))) {
      sendResult({ success: false, error: `data.path must be absolute (got: ${path})` });
      return;
    }
    if (data.base64 !== void 0 || data.url !== void 0) {
      sendResult({
        success: false,
        error: 'trusted mode only accepts "data.path"; "base64"/"url" go through the synthetic (non-trusted) path \u2014 drop trusted:true for those'
      });
      return;
    }
    const filename = path.split(/[\\/]/).filter(Boolean).pop() || path;
    const uploadWarnings = [];
    try {
      if (tabId == null) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tid = tabs[0]?.id;
        if (tid == null) {
          sendResult({ success: false, error: "No active tab" });
          return;
        }
        tabId = tid;
      }
      let x = params.x;
      let y = params.y;
      let cdpFrameId;
      let hitFrame;
      let coordsFromInPage = false;
      if (x == null || y == null) {
        if (!selector && !params.text) {
          sendResult({ success: false, error: 'upload_dragdrop (trusted mode) needs "selector", "text", or {x, y}' });
          return;
        }
        const frames = await resolveSearchFrames(tabId, params.frame);
        for (const f of frames) {
          const r = await sendToFrame(tabId, f.frameId, {
            type: "execute_command",
            payload: { command: "get_rect", params: { selector, text: params.text, scroll: true } }
          }, 8e3);
          if (r.missing || r.response?.notFound) continue;
          const d = r.response?.data;
          if (d?.crossOrigin) {
            cdpFrameId = f.frameId;
            hitFrame = f;
            break;
          }
          x = d?.x;
          y = d?.y;
          coordsFromInPage = true;
          hitFrame = f;
          break;
        }
      }
      if (x == null || y == null) {
        sendResult({ success: false, error: `Could not locate element: ${selector || params.text || "unknown"}` });
        return;
      }
      await chrome.debugger.attach({ tabId }, "1.3");
      try {
        await settleAttachedViewport((method, p, timeoutMs) => cdpSend(tabId, method, p, timeoutMs), tabId);
        if (coordsFromInPage && hitFrame) {
          const r = await sendToFrame(tabId, hitFrame.frameId, {
            type: "execute_command",
            payload: { command: "get_rect", params: { selector, text: params.text, scroll: true } }
          }, 8e3);
          const d = r.response?.data;
          if (typeof d?.x === "number" && typeof d?.y === "number") {
            x = d.x;
            y = d.y;
          }
        }
        if (cdpFrameId != null) {
          const point = await getElementCenterViaCdp(tabId, cdpFrameId, params);
          if (!point) {
            sendResult({ success: false, error: `Could not locate element in iframe via CDP: ${selector}` });
            return;
          }
          x = point.x;
          y = point.y;
        }
        const activationIssue = await activateTabBounded(tabId);
        if (activationIssue) uploadWarnings.push(activationIssue);
        await moveMouseBounded(tabId, x, y, uploadWarnings);
        await new Promise((r) => setTimeout(r, 120));
        const dragData = { files: [path], items: [], dragOperationsMask: 1 };
        await cdpSend(tabId, "Input.dispatchDragEvent", { type: "dragEnter", x, y, data: dragData });
        await new Promise((r) => setTimeout(r, 120));
        await cdpSend(tabId, "Input.dispatchDragEvent", { type: "dragOver", x, y, data: dragData });
        await new Promise((r) => setTimeout(r, 80));
        await cdpSend(tabId, "Input.dispatchDragEvent", { type: "drop", x, y, data: dragData });
      } finally {
        await chrome.debugger.detach({ tabId }).catch(() => {
        });
      }
      const settleFrameId = hitFrame ? hitFrame.frameId : 0;
      const tabBefore = await chrome.tabs.get(tabId).catch(() => null);
      const beforeUrl = tabBefore?.url || "";
      const { response: settleResp, missing } = await sendToFrame(tabId, settleFrameId, {
        type: "execute_command",
        payload: { command: "wait_for_settle", params: { timeout: 3e3, wait_for: params.waitFor } }
      }, 8e3);
      const settleInfo = settleResp?.data;
      if (missing) {
        const tabNow = await withStepTimeout("read the tab", 3e3, chrome.tabs.get(tabId)).catch(() => null);
        if (!tabNow) {
          sendResult({ success: false, error: "Tab was closed during the real drop \u2014 outcome unknown" });
          return;
        }
        const frames = await withStepTimeout("resolve the frame tree", 5e3, getFrameTree(tabId));
        const now = frames.find((f) => f.frameId === settleFrameId);
        const navigatedNow = !!beforeUrl && !!tabNow.url && tabNow.url !== beforeUrl || settleFrameId !== 0 && !now || !!now && !!hitFrame?.url && !!now.url && now.url !== hitFrame.url;
        if (navigatedNow) {
          sendResult({
            success: true,
            data: {
              selector,
              filename,
              x,
              y,
              trusted: true,
              settleLost: true,
              ...uploadWarnings.length ? { warning: uploadWarnings.join("; ") } : {},
              ...params.waitFor ? { waitFor: { settled: false, skipped: "page navigated after the drop \u2014 condition not evaluated" } } : {}
            }
          });
          return;
        }
        if (params.waitFor) {
          sendResult({ success: false, error: "waitFor could not be verified: content script unresponsive after the real drop (the drop itself was dispatched)" });
          return;
        }
        sendResult({ success: true, data: { selector, filename, x, y, trusted: true, settleLost: true, ...uploadWarnings.length ? { warning: uploadWarnings.join("; ") } : {} } });
        return;
      }
      sendResult({
        success: true,
        data: {
          selector,
          filename,
          x,
          y,
          trusted: true,
          ...uploadWarnings.length ? { warning: uploadWarnings.join("; ") } : {},
          ...settleInfo ? { settledMs: settleInfo.settledMs, settled: settleInfo.settled, ...settleInfo.waitFor ? { waitFor: settleInfo.waitFor } : {} } : {}
        }
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      sendResult({ success: false, error: `Unexpected error while running "upload_dragdrop" (trusted mode): ${detail} (please report this to cda)` });
    }
  }
  async function getElementCenterViaCdp(tabId, frameId, params) {
    await cdpSend(tabId, "DOM.enable");
    await cdpSend(tabId, "Runtime.enable");
    await cdpSend(tabId, "Page.enable");
    const contexts = [];
    const onEvent = (_src, method, eventParams) => {
      if (method === "Runtime.executionContextCreated") {
        const ctx2 = eventParams?.context;
        if (ctx2?.id != null) {
          contexts.push({
            id: ctx2.id,
            frameId: ctx2.auxData?.frameId,
            isDefault: ctx2.auxData?.isDefault
          });
        }
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    await new Promise((r) => setTimeout(r, 300));
    chrome.debugger.onEvent.removeListener(onEvent);
    const ctx = contexts.find((c) => c.isDefault && c.frameId === String(frameId));
    if (!ctx) return null;
    const selector = params.selector;
    const text = params.text;
    const expression = `(()=>{
    const roots = function(root){
      // root \u4E3A\u5143\u7D20\u65F6\u5305\u542B\u5176\u81EA\u8EAB shadowRoot\uFF08>>> \u7A7F\u900F\u5BBF\u4E3B\u81EA\u8EAB\u8FB9\u754C\uFF09\uFF0C\u518D\u9012\u5F52\u6536\u96C6\u5D4C\u5957 root
      const out=[];
      const walk = function(r){
        if(r instanceof Element && r.shadowRoot){ out.push(r.shadowRoot); walk(r.shadowRoot); }
        r.querySelectorAll("*").forEach(function(el){
          if(el.shadowRoot){ out.push(el.shadowRoot); walk(el.shadowRoot); }
        });
      };
      walk(root);
      return out;
    };
    const hasShadowToken = function(sel){
      let quote=null, depth=0;
      for(let i=0;i<sel.length;i++){
        const ch=sel[i];
        if(quote){ if(ch===quote) quote=null; continue; }
        if(ch==="'"||ch==='"'){ quote=ch; continue; }
        if(ch==="("||ch==="["){ depth++; continue; }
        if(ch===")"||ch==="]"){ depth=Math.max(0,depth-1); continue; }
        if(depth>0) continue;
        if(ch===">"&&sel[i+1]===">"&&sel[i+2]===">") return true;
        if(ch==="#"&&sel.slice(i+1).startsWith("shadow-root")) return true;
      }
      return false;
    };
    const q = function(ctx, seg){
      try { return Array.from(ctx.querySelectorAll(seg)); } catch(e){ return []; }
    };
    // \u8DEF\u5F84\u884C\u8D70\uFF1ACSS \u6BB5\u5728\u5F53\u524D\u5019\u9009\u5185\u67E5\u627E\uFF0C#shadow-root \u53D6\u5BBF\u4E3B shadowRoot\uFF0C>>> \u7A7F\u900F\u6240\u6709\u5C42
    const walk = function(sel){
      const tokens=[]; let quote=null, depth=0, cur="";
      const flush=function(){ const s=cur.trim(); if(s) tokens.push({kind:"css",value:s}); cur=""; };
      for(let i=0;i<sel.length;i++){
        const ch=sel[i];
        if(quote){ cur+=ch; if(ch===quote) quote=null; continue; }
        if(ch==="'"||ch==='"'){ quote=ch; cur+=ch; continue; }
        if(ch==="("||ch==="["){ depth++; cur+=ch; continue; }
        if(ch===")"||ch==="]"){ depth=Math.max(0,depth-1); cur+=ch; continue; }
        if(depth>0){ cur+=ch; continue; }
        if(ch===">"&&sel[i+1]===">"&&sel[i+2]===">"){ flush(); tokens.push({kind:"pierce",value:">>>"}); i+=2; continue; }
        if(ch===">"){ flush(); continue; }
        if(ch==="#"&&sel.slice(i+1).startsWith("shadow-root")){ flush(); tokens.push({kind:"shadowroot",value:"#shadow-root"}); i+="shadow-root".length; continue; }
        cur+=ch;
      }
      flush();
      let cands=[];
      for(const tok of tokens){
        if(tok.kind==="css"){
          const contexts = cands.length?cands:[document];
          let next=[];
          for(const ctx of contexts){ next=next.concat(q(ctx,tok.value)); }
          if(next.length===0){ for(const ctx of contexts){ for(const sr of roots(ctx)){ next=next.concat(q(sr,tok.value)); } } }
          cands=next;
        } else if(tok.kind==="shadowroot"){
          const next=[];
          for(const c of cands){ if(c.shadowRoot) next.push(c.shadowRoot); }
          cands=next;
        } else {
          const next=[];
          for(const c of cands){ next=next.concat(roots(c)); }
          cands=next;
        }
        if(cands.length===0) return null;
      }
      return cands.find(function(c){ return c instanceof Element; }) || null;
    };
    const findCss = function(sel){
      if(hasShadowToken(sel)) return walk(sel);
      const e=document.querySelector(sel);
      if(e) return e;
      const all=roots(document);
      for(let i=0;i<all.length;i++){ const el=all[i].querySelector(sel); if(el) return el; }
      return null;
    };
    const findXPath = function(xpath){
      const r=document.evaluate(xpath,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null);
      const e=r.singleNodeValue; if(e) return e;
      // ShadowRoot \u4E0D\u80FD\u4F5C XPath context node\uFF08#document-fragment \u975E\u6CD5\uFF09\uFF0C\u6309\u9876\u5C42\u5B50\u5143\u7D20\u9010\u4E2A\u6C42\u503C
      const all=roots(document);
      for(let i=0;i<all.length;i++){
        const kids=all[i].children||[];
        for(let k=0;k<kids.length;k++){
          try{ const rr=document.evaluate(xpath,kids[k],null,XPathResult.FIRST_ORDERED_NODE_TYPE,null); if(rr.singleNodeValue) return rr.singleNodeValue; }catch(err){}
        }
      }
      return null;
    };
    const findText = function(text){
      const qq=JSON.stringify(text);
      const hidden="self::script or self::style or self::noscript or self::template or self::head or self::title or self::meta or self::svg or self::path";
      const build=function(prefix){
        return [prefix+"button[contains(normalize-space(.),"+qq+")]",prefix+"a[contains(normalize-space(.),"+qq+")]",prefix+"input[contains(@value,"+qq+")]",prefix+"*[not("+hidden+")][contains(normalize-space(.),"+qq+") and not(./*[not("+hidden+")][contains(normalize-space(.),"+qq+")])]"].join(" | ");
      };
      const vis=function(el){ const s=getComputedStyle(el); return s.display!=="none"&&s.visibility!=="hidden"&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0; };
      const res=document.evaluate(build("//body//"),document,null,XPathResult.ORDERED_NODE_ITERATOR_TYPE,null);
      let el=res.iterateNext();
      while(el){ if(vis(el)) return el; el=res.iterateNext(); }
      const all=roots(document);
      for(let i=0;i<all.length;i++){
        const kids=all[i].children||[];
        for(let k=0;k<kids.length;k++){
          const rr=document.evaluate(build("//"),kids[k],null,XPathResult.ORDERED_NODE_ITERATOR_TYPE,null);
          let e2=rr.iterateNext();
          while(e2){ if(vis(e2)) return e2; e2=rr.iterateNext(); }
        }
      }
      return null;
    };
    const selector=${JSON.stringify(selector ?? "")};
    const text=${JSON.stringify(text ?? "")};
    const found = text ? findText(text) : (selector.slice(0,6)==="xpath:" ? findXPath(selector.slice(6)) : findCss(selector.replace(/^css:/,"")));
    return found || null;
  })()`;
    const evalRes = await cdpSend(tabId, "Runtime.evaluate", {
      contextId: ctx.id,
      expression,
      userGesture: true
    });
    const objectId = evalRes?.result?.objectId;
    if (!objectId) return null;
    const nodeRes = await cdpSend(tabId, "DOM.requestNode", { objectId });
    const nodeId = nodeRes?.nodeId;
    if (nodeId == null) return null;
    const quadsRes = await cdpSend(tabId, "DOM.getContentQuads", { nodeId });
    const quads = quadsRes?.quads;
    if (!quads || quads.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const quad of quads) {
      for (let i = 0; i < quad.length; i += 2) {
        minX = Math.min(minX, quad[i]);
        minY = Math.min(minY, quad[i + 1]);
        maxX = Math.max(maxX, quad[i]);
        maxY = Math.max(maxY, quad[i + 1]);
      }
    }
    if (minX > maxX || minY > maxY) return null;
    return { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) };
  }
  chrome.storage.onChanged.addListener(
    (changes, area) => {
      if (area !== "local") return;
      const config = {};
      let shouldReconnect = false;
      if (changes.nodeName) {
        config.nodeName = changes.nodeName.newValue;
        shouldReconnect = true;
      }
      if (changes.serverUrl) {
        config.serverUrl = changes.serverUrl.newValue;
        shouldReconnect = true;
      }
      if (changes.autoConnect) config.autoConnect = changes.autoConnect.newValue;
      if (shouldReconnect) {
        chrome.storage.local.get(["nodeName", "serverUrl"], (result) => {
          const c = result;
          if (c.nodeName && c.serverUrl) {
            chrome.storage.session.remove("manualDisconnect").catch(() => {
            });
            wsClient.disconnect();
            wsClient.connect(c.serverUrl, c.nodeName);
          }
        });
      }
    }
  );
  function updateBadge(status) {
    const map = {
      connected: { text: "\u2713", color: "#4CAF50" },
      connecting: { text: "\u2026", color: "#FF9800" },
      disconnected: { text: "\u2715", color: "#9E9E9E" },
      error: { text: "!", color: "#F44336" }
    };
    const { text, color } = map[status];
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  }
  function notifyPorts(status) {
    chrome.runtime.sendMessage({
      type: "status_update",
      status,
      retry: wsClient.getRetryState()
    }).catch(() => {
    });
  }
  chrome.runtime.onStartup.addListener(async () => {
    await ensureAlarm();
    autoConnect();
  });
})();
