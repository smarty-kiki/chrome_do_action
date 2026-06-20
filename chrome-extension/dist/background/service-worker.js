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
  var BROWSER_COMMANDS = /* @__PURE__ */ new Set(["open", "list_tabs", "close_tab"]);
  var BLOCKED_COMMANDS = /* @__PURE__ */ new Set(["wait_for_page"]);
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
  function sendToTab(tabId, cmd, params, onDone) {
    const isClick = cmd.payload.command === "click";
    const fieldFilter = cmd.payload.params?._field || [];
    const needCurrent = fieldFilter.length === 0 || fieldFilter.some((f) => f === "currentTab" || f.startsWith("currentTab."));
    const needIframe = fieldFilter.length === 0 || fieldFilter.some((f) => f === "iframeChanges" || f.startsWith("iframeChanges."));
    const needBeforeInfo = isClick && needIframe;
    const tabPromise = chrome.tabs.get(tabId);
    const beforeTabsPromise = tabPromise.then(
      (tab) => chrome.tabs.query({ windowId: tab.windowId })
    );
    const beforeFullInfoPromise = needBeforeInfo ? getFullPageInfo(tabId, cmd.payload.params) : Promise.resolve(null);
    const retrying = { value: false };
    function doSend(targetTabId) {
      function sendResult(payload) {
        wsClient.send({ type: "command_result", payload: { ...payload, data: payload.data } });
      }
      chrome.tabs.sendMessage(targetTabId, {
        type: "execute_command",
        id: cmd.id,
        payload: { command: cmd.payload.command, params }
      }, async (response) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "";
          const NAV_ERROR = "The page keeping the extension port is moved into back/forward cache";
          if (isClick && msg.includes(NAV_ERROR)) {
            try {
              const currentInfo = needCurrent ? await getFullPageInfo(targetTabId, cmd.payload.params) : null;
              sendResult({
                commandId: cmd.id,
                success: true,
                data: {
                  navigated: true,
                  ...needCurrent ? { currentTab: currentInfo } : { currentTab: null }
                }
              });
            } catch {
              sendResult({
                commandId: cmd.id,
                success: true,
                data: { navigated: true, currentTab: null }
              });
            }
            onDone?.();
            return;
          }
          if (!retrying.value && msg.includes("Receiving end does not exist")) {
            retrying.value = true;
            try {
              await injectContentScript(targetTabId);
            } catch {
            }
            doSend(targetTabId);
            return;
          }
          sendResult({
            commandId: cmd.id,
            success: false,
            error: msg.includes("Receiving end does not exist") ? `Tab ${targetTabId}: no content script loaded (is it a chrome:// page or not fully loaded?)` : msg
          });
          onDone?.();
          return;
        }
        const navigated = response?.data?.navigated;
        const needNewTabs = fieldFilter.length === 0 || fieldFilter.some((f) => f === "newTabs" || f.startsWith("newTabs."));
        if (navigated) {
          try {
            const [beforeTabs, currentTab] = await Promise.all([
              beforeTabsPromise,
              chrome.tabs.get(targetTabId)
            ]);
            const beforeIds = new Set(beforeTabs.map((t) => t.id));
            const currentInfo = needCurrent ? await getFullPageInfo(targetTabId, cmd.payload.params) : null;
            const afterTabs = await chrome.tabs.query({ windowId: currentTab.windowId });
            const newTabIds = needNewTabs ? afterTabs.filter((t) => !beforeIds.has(t.id)).map((t) => t.id) : [];
            const newTabInfos = [];
            for (const ntid of newTabIds) {
              try {
                await waitForTabLoad(ntid);
              } catch {
                continue;
              }
              const info = await getFullPageInfo(ntid, cmd.payload.params);
              if (info) newTabInfos.push({ tabId: ntid, ...info });
            }
            const navResult = {
              navigated: true
            };
            if (needCurrent) {
              navResult.currentTab = currentInfo;
            }
            if (needNewTabs && newTabInfos.length > 0) navResult.newTabs = newTabInfos;
            sendResult({
              commandId: cmd.id,
              success: true,
              data: navResult
            });
          } catch {
            sendResult({
              commandId: cmd.id,
              success: true,
              data: { navigated: true, current: null }
            });
          }
        } else if (isClick) {
          const beforeInfo = needBeforeInfo ? await beforeFullInfoPromise : null;
          const afterInfo = needCurrent ? await getFullPageInfo(targetTabId, cmd.payload.params) : null;
          let newTabInfos = [];
          const navigated2 = response?.data?.navigated;
          if (!navigated2 && response?.success && needNewTabs) {
            try {
              const currentTab = await chrome.tabs.get(targetTabId);
              const afterTabs = await chrome.tabs.query({ windowId: currentTab.windowId });
              const beforeTabIds = beforeTabsPromise.then((bt) => new Set(bt.map((t) => t.id)));
              const beforeIds = await beforeTabIds;
              const newTabIds = afterTabs.filter((t) => !beforeIds.has(t.id)).map((t) => t.id);
              for (const ntid of newTabIds) {
                try {
                  await waitForTabLoad(ntid);
                } catch {
                  continue;
                }
                const info = await getFullPageInfo(ntid, cmd.payload.params);
                if (info) newTabInfos.push({ tabId: ntid, ...info });
              }
            } catch {
            }
          }
          const result = {
            navigated: navigated2 ?? false,
            ...typeof response?.data === "object" && response?.data !== null ? response.data : {}
          };
          if (needCurrent) {
            result.currentTab = afterInfo;
          }
          if (needIframe) {
            const iframeChanges = beforeInfo && afterInfo ? diffIframes(beforeInfo.iframes, afterInfo.iframes) : [];
            if (iframeChanges.length > 0) result.iframeChanges = iframeChanges;
          }
          if (needNewTabs && newTabInfos.length > 0) result.newTabs = newTabInfos;
          sendResult({
            commandId: cmd.id,
            success: response?.success ?? false,
            data: result,
            error: response?.error
          });
        } else {
          sendResult({
            commandId: cmd.id,
            success: response?.success ?? false,
            data: response?.data,
            error: response?.error
          });
        }
        onDone?.();
      });
    }
    doSend(tabId);
  }
  async function getFullPageInfo(tabId, cmdParams) {
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
      const needContentScript = mappedFields.some((f) => f === "iframes" || f === "html" || f === "jsErrors");
      if (needContentScript) {
        await waitForTabLoad(tabId);
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 300));
          const resp = await new Promise((resolve) => {
            const timer2 = setTimeout(() => resolve({}), 2e3);
            chrome.tabs.sendMessage(tabId, {
              type: "execute_command",
              payload: { command: "get_page_info", params: { _field: mappedFields } }
            }, (r) => {
              clearTimeout(timer2);
              if (chrome.runtime.lastError) return resolve({});
              resolve(r);
            });
          });
          if (resp.data?.iframes && resp.data.iframes.length > 0) {
            result.iframes = resp.data.iframes;
            break;
          }
        }
      }
      if (fields.length > 0) {
        const filtered = {};
        const hasField = (name) => fields.some((f) => f === name || f === `currentTab.${name}`);
        if (hasField("url")) filtered.url = result.url;
        if (hasField("title")) filtered.title = result.title;
        if (hasField("iframes")) filtered.iframes = result.iframes;
        if (hasField("html")) filtered.html = result.html;
        return filtered;
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
        const timer2 = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error(`Tab ${tabId} load timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const listener = (tid, info) => {
          if (tid === tabId && info.status === "complete") {
            chrome.tabs.get(tabId, (t) => {
              if (t.url) {
                clearTimeout(timer2);
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
      const timer2 = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error(`Content script injection timed out after ${INJECT_TIMEOUT}ms`));
      }, INJECT_TIMEOUT);
      const listener = (_msg) => {
        if (_msg.type === "cs_injected") {
          clearTimeout(timer2);
          chrome.runtime.onMessage.removeListener(listener);
          resolve();
        }
      };
      chrome.runtime.onMessage.addListener(listener);
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        (() => {
          chrome.runtime.onMessage.addListener(
            (msg, _sender, sendResponse) => {
              if (msg.type !== "execute_command") return;
              const { command } = msg.payload;
              const exec = () => handleCommand(msg.payload);
              exec().then(sendResponse);
              return true;
            }
          );
          const jsErrors = [];
          window.addEventListener("error", (ev) => {
            jsErrors.push({ message: ev.message, source: ev.filename, lineno: ev.lineno });
          });
          window.addEventListener("unhandledrejection", (ev) => {
            const reason = ev.reason;
            const msg = typeof reason === "string" ? reason : reason?.message ?? String(reason);
            jsErrors.push({ message: `Unhandled rejection: ${msg}`, source: "unhandledrejection" });
          });
          chrome.runtime.sendMessage({ type: "cs_injected" }).catch(() => {
          });
          async function handleCommand(payload) {
            const { command, params = {} } = payload;
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
                  return { success: true, navigated, data: clickDesc };
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
                  const fields = params._field || [];
                  const data = {};
                  if (fields.length === 0 || fields.includes("url")) data.url = window.location.href;
                  if (fields.length === 0 || fields.includes("title")) data.title = document.title;
                  if (fields.length === 0 || fields.includes("html")) data.html = document.documentElement.outerHTML;
                  if (fields.length === 0 || fields.includes("iframes")) {
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
                    data.iframes = iframes;
                  }
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
      }
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
        await chrome.tabGroups.remove(groupId);
      }
    } catch {
    }
  }
  chrome.tabGroups.onRemoved.addListener(async (gid) => {
    if (gid === groupId) {
      groupId = null;
      groupWindowId = null;
    }
  });
  async function handleBrowserCommand(cmd) {
    const { command, params = {} } = cmd.payload;
    function sendResult(payload) {
      wsClient.send({ type: "command_result", payload: { ...payload, data: payload.data } });
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
