import { WsClient, ConnectionStatus } from "../ws/client";
import type { Message, CommandMessage } from "../ws/types";

interface StoredConfig {
  nodeName: string;
  serverUrl: string;
  autoConnect: boolean;
}

const wsClient = new WsClient({
  maxRetries: 3,
  retryIntervalMs: 15000,
});

// Browser-level commands handled directly in background (no content script needed)
const BROWSER_COMMANDS = new Set(["open", "list_tabs", "close_tab"]);

const GROUP_TITLE = "chrome_do_action";
let groupId: number | null = null;
let groupWindowId: number | null = null;

// Suppress WebSocket connection errors from appearing in DevTools console
// (connection failures to offline servers are expected behavior)
const origConsoleError = console.error;
console.error = (...args: unknown[]) => {
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
      autoConnect: true,
    });
  }
  await ensureAlarm();
  autoConnect();
});

wsClient.onStatusChange((status) => {
  updateBadge(status);
  notifyPorts(status);
});

wsClient.onMessage("command", (msg: Message) => {
  if (msg.type !== "command") return;
  const cmd = msg as CommandMessage;

  if (BROWSER_COMMANDS.has(cmd.payload.command)) {
    handleBrowserCommand(cmd);
    return;
  }

  // Page-level command: forward to target tab (or active tab if not specified)
  const tabId = cmd.payload.params?.tabId as number | undefined;
  const params = { ...cmd.payload.params };
  delete params.tabId; // content script doesn't need tabId

  if (tabId != null) {
    enqueueCommand(tabId, cmd, params);
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tid = tabs[0]?.id;
      if (!tid) {
        wsClient.send({
          type: "command_result",
          payload: { commandId: cmd.id!, success: false, error: "No active tab" },
        });
        return;
      }
      enqueueCommand(tid, cmd, params);
    });
  }
});

chrome.runtime.onMessage.addListener(
  (msg: { type: string }, _sender: chrome.runtime.MessageSender, sendResponse: (res: { status: ConnectionStatus }) => void) => {
    if (msg.type === "connect") {
      const { serverUrl, nodeName } = msg as unknown as { serverUrl: string; nodeName: string };
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
  },
);

chrome.alarms.onAlarm.addListener((alarm: chrome.alarms.Alarm) => {
  if (alarm.name === "keepalive") {
    autoConnect();
  }
});

async function ensureAlarm(): Promise<void> {
  const alarm = await chrome.alarms.get("keepalive");
  if (!alarm) {
    chrome.alarms.create("keepalive", { periodInMinutes: 15 / 60 });
  }
}

interface QueuedCommand {
  cmd: CommandMessage;
  params: Record<string, unknown>;
}

const tabQueues = new Map<number, QueuedCommand[]>();

function enqueueCommand(tabId: number, cmd: CommandMessage, params: Record<string, unknown>): void {
  const entry = tabQueues.get(tabId) || [];
  tabQueues.set(tabId, entry);
  entry.push({ cmd, params });
  if (entry.length === 1) {
    dequeueNext(tabId);
  }
}

function dequeueNext(tabId: number): void {
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

function sendToTab(
  tabId: number,
  cmd: CommandMessage,
  params: Record<string, unknown>,
  onDone?: () => void,
): void {
  const isClick = cmd.payload.command === "click";

  const tabPromise = chrome.tabs.get(tabId);
  const beforeTabsPromise = tabPromise.then((tab) =>
    chrome.tabs.query({ windowId: tab.windowId! }),
  );

  const beforeFullInfoPromise = isClick ? getFullPageInfo(tabId) : Promise.resolve(null);

  chrome.tabs.sendMessage(tabId, {
    type: "execute_command",
    id: cmd.id,
    payload: { command: cmd.payload.command, params },
  }, async (response) => {
    if (chrome.runtime.lastError) {
      const msg = chrome.runtime.lastError.message || "";
      wsClient.send({
        type: "command_result",
        payload: {
          commandId: cmd.id!,
          success: false,
          error: msg.includes("Receiving end does not exist")
            ? `Tab ${tabId}: no content script loaded (is it a chrome:// page or not fully loaded?)`
            : msg,
        },
      });
      onDone?.();
      return;
    }

    const navigated = response?.navigated as boolean | undefined;

    if (navigated) {
      try {
        const [beforeTabs, currentTab] = await Promise.all([
          beforeTabsPromise,
          chrome.tabs.get(tabId),
        ]);
        const beforeIds = new Set(beforeTabs.map((t) => t.id));

        await waitForTabLoad(tabId);
        const currentInfo = await getFullPageInfo(tabId);
        const afterTabs = await chrome.tabs.query({ windowId: currentTab.windowId! });
        const newTabIds = afterTabs.filter((t) => !beforeIds.has(t.id)).map((t) => t.id);

        const newTabInfos: { tabId: number; url: string; title: string; html: string; iframes: FullPageInfo["iframes"] }[] = [];
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
            commandId: cmd.id!,
            success: true,
            data: {
              navigated: true,
              current: currentInfo,
              newTabs: newTabInfos,
            },
          },
        });
      } catch {
        wsClient.send({
          type: "command_result",
          payload: {
            commandId: cmd.id!,
            success: true,
            data: { navigated: true, current: null, newTabs: [] },
          },
        });
      }
    } else if (isClick) {
      const beforeInfo = await beforeFullInfoPromise;
      const afterInfo = await getFullPageInfo(tabId);
      const iframeDiff = beforeInfo && afterInfo
        ? diffIframes(beforeInfo.iframes, afterInfo.iframes)
        : { changed: false, changes: [] };

      const jsErrors = (response as { jsErrors?: { message: string; source: string; lineno?: number }[] } | undefined)?.jsErrors;

      wsClient.send({
        type: "command_result",
        payload: {
          commandId: cmd.id!,
          success: response?.success ?? false,
          data: {
            ...(typeof response?.data === "object" && response?.data !== null ? response.data : {}),
            current: afterInfo,
            iframeChanged: iframeDiff.changed,
            iframeChanges: iframeDiff.changes,
            ...(jsErrors && jsErrors.length > 0 ? { jsErrors } : {}),
          },
          error: response?.error,
        },
      });
    } else {
      wsClient.send({
        type: "command_result",
        payload: {
          commandId: cmd.id!,
          success: response?.success ?? false,
          data: response?.data,
          error: response?.error,
        },
      });
    }
    onDone?.();
  });
}

async function getPageInfo(tabId: number): Promise<{ tabId: number; url: string; title: string; html: string } | null> {
  try {
    await waitForTabLoad(tabId);
    const tab = await chrome.tabs.get(tabId);
    let html = "";
    try {
      const resp = await chrome.tabs.sendMessage(tabId, {
        type: "execute_command",
        payload: { command: "get_page_info" },
      });
      const data = (resp as { data?: { url: string; title: string; html: string } } | undefined)?.data;
      if (data) {
        html = data.html;
      }
    } catch {
      html = "";
    }
    return { tabId: tab.id!, url: tab.url ?? "", title: tab.title, html };
  } catch {
    return null;
  }
}

interface FullPageInfo {
  url: string;
  title: string;
  html: string;
  iframes: { index: number; src: string; sameOrigin: boolean; url?: string; html?: string }[];
  jsErrors?: { message: string; source: string; lineno?: number }[];
}

async function getFullPageInfo(tabId: number): Promise<FullPageInfo | null> {
  try {
    const resp = await new Promise<{ data?: FullPageInfo }>((resolve) => {
      chrome.tabs.sendMessage(tabId, {
        type: "execute_command",
        payload: { command: "get_full_page_info" },
      }, (r) => {
        if (chrome.runtime.lastError) return resolve({});
        resolve(r as { data?: FullPageInfo });
      });
    });
    return resp.data ?? null;
  } catch {
    return null;
  }
}

function diffIframes(
  before: FullPageInfo["iframes"],
  after: FullPageInfo["iframes"],
): { changed: boolean; changes: { index: number; srcChanged: boolean; htmlChanged: boolean; beforeSrc: string; afterSrc: string }[] } {
  const beforeMap = new Map(before.map((f) => [f.index, f]));
  const afterMap = new Map(after.map((f) => [f.index, f]));
  const changes: { index: number; srcChanged: boolean; htmlChanged: boolean; beforeSrc: string; afterSrc: string }[] = [];

  const allIndices = new Set([...beforeMap.keys(), ...afterMap.keys()]);
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

function waitForTabLoad(tabId: number, timeoutMs = 30000): Promise<void> {
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
      const listener = (tid: number, info: chrome.tabs.TabChangeInfo) => {
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

async function getOrCreateGroup(windowId: number): Promise<{ groupId: number; windowId: number }> {
  if (groupId != null && groupWindowId === windowId) {
    try {
      await chrome.tabGroups.get(groupId);
      return { groupId, windowId };
    } catch {
      groupId = null;
      groupWindowId = null;
    }
  }

  const existing = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
  if (existing.length > 0) {
    groupId = existing[0].id!;
    groupWindowId = windowId;
    return { groupId, windowId };
  }

  groupId = await chrome.tabs.group({ windowId });
  groupWindowId = windowId;
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "grey" });
  return { groupId, windowId };
}

async function cleanupGroupIfEmpty(): Promise<void> {
  if (groupId == null || groupWindowId == null) return;
  try {
    const tabs = await chrome.tabs.query({ groupId });
    if (tabs.length === 0) {
      await chrome.tabGroups.remove(groupId);
    }
  } catch {
    // group already removed
  }
}

chrome.tabGroups.onRemoved.addListener(async (gid: number) => {
  if (gid === groupId) {
    groupId = null;
    groupWindowId = null;
  }
});

async function handleBrowserCommand(cmd: CommandMessage): Promise<void> {
  const { command, params = {} } = cmd.payload;

  try {
    switch (command) {
      case "open": {
        const url = (params.url as string) || "about:blank";
        const tab = await chrome.tabs.create({ url });
        const { groupId: gid } = await getOrCreateGroup(tab.windowId!);
        await chrome.tabs.group({ tabIds: tab.id!, groupId: gid });
        const fullInfo = await getFullPageInfo(tab.id!);
        wsClient.send({
          type: "command_result",
          payload: {
            commandId: cmd.id!,
            success: true,
            data: fullInfo,
          },
        });
        break;
      }

      case "list_tabs": {
        const tabs = await chrome.tabs.query({});
        wsClient.send({
          type: "command_result",
          payload: {
            commandId: cmd.id!,
            success: true,
            data: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
          },
        });
        break;
      }

      case "close_tab": {
        let tabId: number;
        if (params.tabId === "current") {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tabs[0]?.id) {
            wsClient.send({
              type: "command_result",
              payload: { commandId: cmd.id!, success: false, error: "No active tab" },
            });
            return;
          }
          tabId = tabs[0].id;
        } else {
          tabId = params.tabId as number;
        }
        if (tabId == null) {
          wsClient.send({
            type: "command_result",
            payload: { commandId: cmd.id!, success: false, error: "Missing tabId parameter" },
          });
          return;
        }
        tabQueues.delete(tabId);
        await chrome.tabs.remove(tabId);
        cleanupGroupIfEmpty();
        wsClient.send({
          type: "command_result",
          payload: { commandId: cmd.id!, success: true, data: { tabId } },
        });
        break;
      }

      default:
        wsClient.send({
          type: "command_result",
          payload: { commandId: cmd.id!, success: false, error: `Unknown browser command: ${command}` },
        });
    }
  } catch (err) {
    wsClient.send({
      type: "command_result",
      payload: { commandId: cmd.id!, success: false, error: String(err) },
    });
  }
}

async function autoConnect(): Promise<void> {
  if (wsClient.getStatus() === "connected" || wsClient.getStatus() === "connecting") {
    return;
  }
  // 如果已有定时重试在排队，不干扰 WsClient 自身的重试节奏
  const retry = wsClient.getRetryState();
  if (retry.nextRetryAt && retry.nextRetryAt > Date.now()) {
    return;
  }
  const result = await chrome.storage.local.get(["nodeName", "serverUrl", "autoConnect"]);
  const config = result as Partial<StoredConfig>;
  if (config.autoConnect && config.serverUrl && config.nodeName) {
    wsClient.connect(config.serverUrl, config.nodeName);
  }
}

chrome.storage.onChanged.addListener(
  (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
    if (area !== "local") return;
    const config: Partial<StoredConfig> = {};
    let shouldReconnect = false;
    if (changes.nodeName) {
      config.nodeName = changes.nodeName.newValue as string;
      shouldReconnect = true;
    }
    if (changes.serverUrl) {
      config.serverUrl = changes.serverUrl.newValue as string;
      shouldReconnect = true;
    }
    if (changes.autoConnect) config.autoConnect = changes.autoConnect.newValue as boolean;
    if (shouldReconnect) {
      chrome.storage.local.get(["nodeName", "serverUrl"], (result) => {
        const c = result as unknown as StoredConfig;
        if (c.nodeName && c.serverUrl) {
          wsClient.disconnect();
          wsClient.connect(c.serverUrl, c.nodeName);
        }
      });
    }
  },
);

function updateBadge(status: ConnectionStatus): void {
  const map: Record<ConnectionStatus, { text: string; color: string }> = {
    connected: { text: "✓", color: "#4CAF50" },
    connecting: { text: "…", color: "#FF9800" },
    disconnected: { text: "✕", color: "#9E9E9E" },
    error: { text: "!", color: "#F44336" },
  };
  const { text, color } = map[status];
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function notifyPorts(status: ConnectionStatus): void {
  chrome.runtime.sendMessage({
    type: "status_update",
    status,
    retry: wsClient.getRetryState(),
  }).catch(() => {});
}

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  autoConnect();
});
