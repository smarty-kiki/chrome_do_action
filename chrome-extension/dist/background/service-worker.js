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
    const result = await chrome.storage.local.get(["nodeName", "serverUrl", "autoConnect"]);
    if (!result.nodeName && !result.serverUrl) {
      await chrome.storage.local.set({
        nodeName: "",
        serverUrl: "",
        autoConnect: true
      });
    }
    await ensureAlarm();
    autoConnect();
  });
  wsClient.onStatusChange((status) => {
    updateBadge(status);
    notifyPorts(status);
  });
  wsClient.onMessage("command", (msg) => {
    if (msg.type !== "command") return;
    const cmd = msg;
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
    (msg, _sender, sendResponse) => {
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
        sendResponse({ status: wsClient.getStatus() });
      } else if (msg.type === "get_status") {
        sendResponse({ status: wsClient.getStatus(), retry: wsClient.getRetryState() });
      }
      return true;
    }
  );
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") {
      autoConnect();
    }
  });
  async function ensureAlarm() {
    const alarm = await chrome.alarms.get("keepalive");
    if (!alarm) {
      chrome.alarms.create("keepalive", { periodInMinutes: 15 / 60 });
    }
  }
  function applyFieldFilter(data, fields) {
    if (fields.length === 0) return data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
    const src = data;
    const out = {};
    for (const f of fields) {
      const keys = f.split(".").filter(Boolean);
      const root = keys[0];
      if (!keys.length || !(root in src)) continue;
      const picked = pickPath(src[root], keys.slice(1));
      if (picked !== void 0) out[root] = picked;
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
    let beforeTabs = [];
    let beforeFullInfo = null;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (needBeforeInfo || needNewTabs) {
        beforeTabs = await chrome.tabs.query({ windowId: tab.windowId });
      }
      if (needBeforeInfo) {
        beforeFullInfo = await getFullPageInfo(tabId, cmd.payload.params, true);
      }
    } catch {
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
      sendResult({ commandId: cmd.id, success: response2?.success ?? false, data: response2?.data, error: response2?.error });
      onDone?.();
      return;
    }
    const isCoordinateClick = isClick && params.x !== void 0 && params.y !== void 0;
    const searchable = ELEMENT_SEARCH_COMMANDS.has(command) && !isCoordinateClick;
    let response;
    let matchedFrame;
    let navigatedFallback = false;
    async function doSearch() {
      if (!searchable) {
        const r = await sendToFrame(tabId, 0, msg);
        response = r.response;
        return;
      }
      const frames = await resolveSearchFrames(tabId, params.frame);
      const slowCommands = /* @__PURE__ */ new Set(["click", "type", "keyboard", "upload_file", "paste_rich", "scroll"]);
      for (const f of frames) {
        const r = await sendToFrame(tabId, f.frameId, msg, slowCommands.has(command) ? 1e4 : 1200);
        if (r.missing) {
          if (isClick) {
            navigatedFallback = true;
            matchedFrame = f;
            break;
          }
          continue;
        }
        if (r.response?.notFound) continue;
        response = r.response;
        matchedFrame = f;
        break;
      }
    }
    let injected = false;
    while (true) {
      await doSearch();
      if (response || navigatedFallback) break;
      if (injected) break;
      try {
        await injectContentScript(tabId);
        injected = true;
      } catch {
        break;
      }
    }
    if (!response && !navigatedFallback) {
      response = { success: false, error: "Element not found: no match in any frame" };
    }
    const frameAttribution = matchedFrame ? { frame: { frameId: matchedFrame.frameId, url: matchedFrame.url } } : {};
    try {
      const wasNavigated = navigatedFallback || response?.data?.navigated === true;
      if (wasNavigated) {
        const currentInfo = needCurrent ? await getFullPageInfo(tabId, cmd.payload.params) : null;
        const navResult = { navigated: true };
        if (needCurrent) navResult.currentTab = currentInfo;
        if (needNewTabs) {
          const newTabInfos = await collectNewTabs(tabId, beforeTabs, cmd.payload.params);
          if (newTabInfos.length > 0) navResult.newTabs = newTabInfos;
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
        if (needCurrent) result.currentTab = afterInfo;
        if (needIframe) {
          const iframeChanges = beforeFullInfo && afterInfo ? diffIframes(beforeFullInfo.iframes, afterInfo.iframes) : [];
          if (iframeChanges.length > 0) result.iframeChanges = iframeChanges;
        }
        if (needNewTabs && newTabInfos.length > 0) result.newTabs = newTabInfos;
        sendResult({ commandId: cmd.id, success: response?.success ?? false, data: result, error: response?.error });
        onDone?.();
        return;
      }
      const data = typeof response?.data === "object" && response?.data !== null && !Array.isArray(response.data) ? { ...response.data, ...frameAttribution } : response?.data;
      sendResult({ commandId: cmd.id, success: response?.success ?? false, data, error: response?.error });
      onDone?.();
    } catch (err) {
      sendResult({ commandId: cmd.id, success: false, error: String(err) });
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
  var ELEMENT_SEARCH_COMMANDS = /* @__PURE__ */ new Set(["click", "type", "keyboard", "get_text", "get_css", "show", "upload_file", "paste_rich", "get_rect"]);
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
      const timer = setTimeout(() => resolve({ missing: true }), timeoutMs);
      try {
        chrome.tabs.sendMessage(tabId, msg, { frameId }, (r) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ missing: true });
            return;
          }
          resolve({
            response: r
          });
        });
      } catch {
        clearTimeout(timer);
        resolve({ missing: true });
      }
    });
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
          const url = params.url || "about:blank";
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
            if (!tabs[0]?.id) {
              sendResult({ commandId: cmd.id, success: false, error: "No active tab" });
              return;
            }
            tabId = tabs[0].id;
          } else {
            tabId = params.tabId;
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
            if (!tabs[0]?.id) {
              sendResult({ commandId: cmd.id, success: false, error: "No active tab" });
              return;
            }
            tabId = tabs[0].id;
          } else {
            tabId = params.tabId;
          }
          if (tabId == null) {
            sendResult({ commandId: cmd.id, success: false, error: "Missing tabId parameter" });
            return;
          }
          tabQueues.delete(tabId);
          await chrome.tabs.remove(tabId);
          cleanupGroupIfEmpty();
          sendResult({ commandId: cmd.id, success: true, data: { tabId } });
          break;
        }
        default:
          sendResult({ commandId: cmd.id, success: false, error: `Unknown browser command: ${command}` });
      }
    } catch (err) {
      wsClient.send({
        type: "command_result",
        payload: { commandId: cmd.id, success: false, error: String(err) }
      });
    }
  }
  async function autoConnect() {
    if (wsClient.getStatus() === "connected" || wsClient.getStatus() === "connecting") {
      return;
    }
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
          const result = await cdpSend(tabId, "Page.captureScreenshot", {
            format: "png"
          });
          sendResult({ success: true, data: result?.data ?? null });
        } finally {
          await chrome.debugger.detach({ tabId }).catch(() => {
          });
        }
        return;
      }
      if (params.x == null && params.y == null && !selector && !params.text) {
        sendResult({ success: false, error: 'real_click needs "selector", "text", or {x, y}' });
        return;
      }
      let x = params.x;
      let y = params.y;
      let cdpFrameId;
      let hitFrame;
      if (x == null || y == null) {
        const frames = await resolveSearchFrames(tabId, params.frame);
        for (const f of frames) {
          const r = await sendToFrame(tabId, f.frameId, {
            type: "execute_command",
            payload: { command: "get_rect", params: { selector, text: params.text } }
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
        if (cdpFrameId != null) {
          const point = await getElementCenterViaCdp(tabId, cdpFrameId, params);
          if (!point) {
            sendResult({ success: false, error: `Could not locate element in iframe via CDP: ${selector}` });
            return;
          }
          x = point.x;
          y = point.y;
        }
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.windowId != null) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          await chrome.tabs.update(tabId, { active: true });
        } catch {
        }
        const clickPoint = { x, y, button: "left", clickCount: 1 };
        if (approach && approach.length) {
          for (const [ax, ay] of approach) {
            await moveMouseInSteps(tabId, ax, ay);
            await new Promise((r) => setTimeout(r, 150));
          }
        }
        await moveMouseInSteps(tabId, x, y);
        await new Promise((r) => setTimeout(r, approach && approach.length ? 400 : 120));
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
      let settleInfo;
      if (hitFrame) {
        const { response } = await sendToFrame(tabId, hitFrame.frameId, {
          type: "execute_command",
          payload: { command: "wait_for_settle", params: { timeout: 3e3, wait_for: params.waitFor } }
        }, 8e3);
        settleInfo = response?.data;
      }
      sendResult({ success: true, data: { x, y, trusted: true, ...settleInfo ? { settledMs: settleInfo.settledMs, settled: settleInfo.settled, ...settleInfo.waitFor ? { waitFor: settleInfo.waitFor } : {} } : {} } });
    } catch (err) {
      sendResult({ success: false, error: String(err) });
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
