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
    wsClient.send({
      type: "command_result",
      payload: {
        commandId: cmd.id!,
        success: response?.success ?? false,
        data: response?.data,
        error: response?.error,
      },
    });

    // 点击触发了页面跳转，等加载完成后补发一次结果
    if (response?.navigated) {
      try {
        await waitForTabLoad(tabId);
        const tab = await chrome.tabs.get(tabId);
        wsClient.send({
          type: "command_result",
          payload: {
            commandId: cmd.id!,
            success: true,
            data: { url: tab.url, title: tab.title },
          },
        });
      } catch {
        // 超时或 tab 已关闭
      }
    }
    onDone?.();
  });
}

function waitForTabLoad(tabId: number, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
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
}

async function handleBrowserCommand(cmd: CommandMessage): Promise<void> {
  const { command, params = {} } = cmd.payload;

  try {
    switch (command) {
      case "open": {
        const url = (params.url as string) || "about:blank";
        const tab = await chrome.tabs.create({ url });
        await waitForTabLoad(tab.id!);
        const finalTab = await chrome.tabs.get(tab.id!);
        wsClient.send({
          type: "command_result",
          payload: {
            commandId: cmd.id!,
            success: true,
            data: { tabId: finalTab.id, url: finalTab.url, title: finalTab.title },
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
