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
    const tabPromise = chrome.tabs.get(tabId);
    const beforeTabsPromise = tabPromise.then(
      (tab) => chrome.tabs.query({ windowId: tab.windowId })
    );
    const beforeFullInfoPromise = isClick ? getFullPageInfo(tabId) : Promise.resolve(null);
    chrome.tabs.sendMessage(tabId, {
      type: "execute_command",
      id: cmd.id,
      payload: { command: cmd.payload.command, params }
    }, async (response) => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || "";
        wsClient.send({
          type: "command_result",
          payload: {
            commandId: cmd.id,
            success: false,
            error: msg.includes("Receiving end does not exist") ? `Tab ${tabId}: no content script loaded (is it a chrome:// page or not fully loaded?)` : msg
          }
        });
        onDone?.();
        return;
      }
      const navigated = response?.navigated;
      if (navigated) {
        try {
          const [beforeTabs, currentTab] = await Promise.all([
            beforeTabsPromise,
            chrome.tabs.get(tabId)
          ]);
          const beforeIds = new Set(beforeTabs.map((t) => t.id));
          await waitForTabLoad(tabId);
          const currentInfo = await getFullPageInfo(tabId);
          const afterTabs = await chrome.tabs.query({ windowId: currentTab.windowId });
          const newTabIds = afterTabs.filter((t) => !beforeIds.has(t.id)).map((t) => t.id);
          const newTabInfos = [];
          for (const ntid of newTabIds) {
            try {
              await waitForTabLoad(ntid);
            } catch {
              continue;
            }
            const info = await getFullPageInfo(ntid);
            if (info) newTabInfos.push({ tabId: ntid, ...info });
          }
          wsClient.send({
            type: "command_result",
            payload: {
              commandId: cmd.id,
              success: true,
              data: {
                navigated: true,
                current: currentInfo,
                newTabs: newTabInfos
              }
            }
          });
        } catch {
          wsClient.send({
            type: "command_result",
            payload: {
              commandId: cmd.id,
              success: true,
              data: { navigated: true, current: null, newTabs: [] }
            }
          });
        }
      } else if (isClick) {
        const beforeInfo = await beforeFullInfoPromise;
        const afterInfo = await getFullPageInfo(tabId);
        const iframeDiff = beforeInfo && afterInfo ? diffIframes(beforeInfo.iframes, afterInfo.iframes) : { changed: false, changes: [] };
        const jsErrors = response?.jsErrors;
        wsClient.send({
          type: "command_result",
          payload: {
            commandId: cmd.id,
            success: response?.success ?? false,
            data: {
              ...typeof response?.data === "object" && response?.data !== null ? response.data : {},
              current: afterInfo,
              iframeChanged: iframeDiff.changed,
              iframeChanges: iframeDiff.changes,
              ...jsErrors && jsErrors.length > 0 ? { jsErrors } : {}
            },
            error: response?.error
          }
        });
      } else {
        wsClient.send({
          type: "command_result",
          payload: {
            commandId: cmd.id,
            success: response?.success ?? false,
            data: response?.data,
            error: response?.error
          }
        });
      }
      onDone?.();
    });
  }
  async function getFullPageInfo(tabId) {
    try {
      const resp = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, {
          type: "execute_command",
          payload: { command: "get_full_page_info" }
        }, (r) => {
          if (chrome.runtime.lastError) return resolve({});
          resolve(r);
        });
      });
      return resp.data ?? null;
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
        changes.push({ index: idx, srcChanged: true, htmlChanged: true, beforeSrc: "", afterSrc: a.src });
      } else if (b && !a) {
        changes.push({ index: idx, srcChanged: true, htmlChanged: true, beforeSrc: b.src, afterSrc: "" });
      } else if (b && a) {
        const srcChanged = b.src !== a.src;
        const htmlChanged = b.sameOrigin && a.sameOrigin && b.html !== a.html;
        if (srcChanged || htmlChanged) {
          changes.push({ index: idx, srcChanged, htmlChanged, beforeSrc: b.src, afterSrc: a.src });
        }
      }
    }
    return { changed: changes.length > 0, changes };
  }
  function waitForTabLoad(tabId, timeoutMs = 3e4) {
    return new Promise((resolve, reject) => {
      chrome.tabs.get(tabId, (tab) => {
        if (tab.status === "complete") {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error(`Tab ${tabId} load timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const listener = (tid, info) => {
          if (tid === tabId && info.status === "complete") {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    });
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
          const fullInfo = await getFullPageInfo(tab.id);
          wsClient.send({
            type: "command_result",
            payload: {
              commandId: cmd.id,
              success: true,
              data: fullInfo
            }
          });
          break;
        }
        case "list_tabs": {
          const tabs = await chrome.tabs.query({});
          wsClient.send({
            type: "command_result",
            payload: {
              commandId: cmd.id,
              success: true,
              data: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }))
            }
          });
          break;
        }
        case "close_tab": {
          let tabId;
          if (params.tabId === "current") {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs[0]?.id) {
              wsClient.send({
                type: "command_result",
                payload: { commandId: cmd.id, success: false, error: "No active tab" }
              });
              return;
            }
            tabId = tabs[0].id;
          } else {
            tabId = params.tabId;
          }
          if (tabId == null) {
            wsClient.send({
              type: "command_result",
              payload: { commandId: cmd.id, success: false, error: "Missing tabId parameter" }
            });
            return;
          }
          tabQueues.delete(tabId);
          await chrome.tabs.remove(tabId);
          cleanupGroupIfEmpty();
          wsClient.send({
            type: "command_result",
            payload: { commandId: cmd.id, success: true, data: { tabId } }
          });
          break;
        }
        default:
          wsClient.send({
            type: "command_result",
            payload: { commandId: cmd.id, success: false, error: `Unknown browser command: ${command}` }
          });
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
