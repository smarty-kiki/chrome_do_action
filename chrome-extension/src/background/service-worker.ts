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
  const fieldFilter = ((cmd.payload.params as Record<string, string[]> | undefined)?._field) || [];
  const needCurrent = fieldFilter.length === 0 || fieldFilter.some(f => f === "currentTab" || f.startsWith("currentTab."));
  const needIframe = fieldFilter.length === 0 || fieldFilter.some(f => f === "iframeChanges" || f.startsWith("iframeChanges."));
  const needBeforeInfo = isClick && needIframe;

  const tabPromise = chrome.tabs.get(tabId);
  const beforeTabsPromise = tabPromise.then((tab) =>
    chrome.tabs.query({ windowId: tab.windowId! }),
  );
  const beforeFullInfoPromise = needBeforeInfo
    ? getFullPageInfo(tabId, cmd.payload.params as Record<string, string[]> | undefined)
    : Promise.resolve(null);

  const retrying = { value: false };

  function doSend(targetTabId: number): void {
    function sendResult(payload: { commandId: string; success: boolean; data?: unknown; error?: string | undefined }): void {
      wsClient.send({ type: "command_result", payload: { ...payload, data: payload.data } });
    }

    chrome.tabs.sendMessage(targetTabId, {
      type: "execute_command",
      id: cmd.id,
      payload: { command: cmd.payload.command, params },
    }, async (response) => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || "";

        // 点击导致页面导航：内容脚本在返回前被销毁，消息通道关闭
        // 不重试（避免在新页面上重复执行 click），直接获取新页面信息
        const NAV_ERROR = "The page keeping the extension port is moved into back/forward cache";
        if (isClick && msg.includes(NAV_ERROR)) {
          try {
            const currentInfo = needCurrent
              ? await getFullPageInfo(targetTabId, cmd.payload.params as Record<string, string[]> | undefined)
              : null;
            sendResult({
              commandId: cmd.id!,
              success: true,
              data: {
                navigated: true,
                ...(needCurrent ? { currentTab: currentInfo } : { currentTab: null }),
              },
            });
          } catch {
            sendResult({
              commandId: cmd.id!,
              success: true,
              data: { navigated: true, currentTab: null },
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
            // injection failed, fall through to error
          }
          doSend(targetTabId);
          return;
        }
        sendResult({
          commandId: cmd.id!,
          success: false,
          error: msg.includes("Receiving end does not exist")
            ? `Tab ${targetTabId}: no content script loaded (is it a chrome:// page or not fully loaded?)`
            : msg,
        });
        onDone?.();
        return;
      }

      const navigated = (response?.data as Record<string, unknown> | undefined)?.navigated as boolean | undefined;
      const needNewTabs = fieldFilter.length === 0 || fieldFilter.some(f => f === "newTabs" || f.startsWith("newTabs."));

      if (navigated) {
        try {
          const [beforeTabs, currentTab] = await Promise.all([
            beforeTabsPromise,
            chrome.tabs.get(targetTabId),
          ]);
          const beforeIds = new Set(beforeTabs.map((t) => t.id));

          const currentInfo = needCurrent
            ? await getFullPageInfo(targetTabId, cmd.payload.params as Record<string, string[]> | undefined)
            : null;
          const afterTabs = await chrome.tabs.query({ windowId: currentTab.windowId! });
          const newTabIds = needNewTabs
            ? afterTabs.filter((t) => !beforeIds.has(t.id)).map((t) => t.id)
            : [];

          const newTabInfos: { tabId: number; url: string; title: string; iframes: FullPageInfo["iframes"] }[] = [];
          for (const ntid of newTabIds) {
            try {
              await waitForTabLoad(ntid);
            } catch {
              continue;
            }
            const info = await getFullPageInfo(ntid, cmd.payload.params as Record<string, string[]> | undefined);
            if (info) newTabInfos.push({ tabId: ntid, ...info });
          }

        const navResult: Record<string, unknown> = {
          navigated: true,
        };
        if (needCurrent) {
          navResult.currentTab = currentInfo;
        }
        if (needNewTabs && newTabInfos.length > 0) navResult.newTabs = newTabInfos;
        sendResult({
          commandId: cmd.id!,
          success: true,
          data: navResult,
        });
        } catch {
          sendResult({
            commandId: cmd.id!,
            success: true,
            data: { navigated: true, current: null },
          });
        }
      } else if (isClick) {
        const beforeInfo = needBeforeInfo ? await beforeFullInfoPromise : null;
        const afterInfo = needCurrent
          ? await getFullPageInfo(targetTabId, cmd.payload.params as Record<string, string[]> | undefined)
          : null;

        let newTabInfos: { tabId: number; url: string; title: string; iframes: FullPageInfo["iframes"] }[] = [];
        const navigated = (response?.data as Record<string, unknown> | undefined)?.navigated as boolean | undefined;
        if (!navigated && response?.success && needNewTabs) {
          try {
            const currentTab = await chrome.tabs.get(targetTabId);
            const afterTabs = await chrome.tabs.query({ windowId: currentTab.windowId! });
            const beforeTabIds = beforeTabsPromise.then(bt => new Set(bt.map(t => t.id)));
            const beforeIds = await beforeTabIds;
            const newTabIds = afterTabs.filter(t => !beforeIds.has(t.id)).map(t => t.id);
            for (const ntid of newTabIds) {
              try { await waitForTabLoad(ntid); } catch { continue; }
              const info = await getFullPageInfo(ntid, cmd.payload.params as Record<string, string[]> | undefined);
              if (info) newTabInfos.push({ tabId: ntid, ...info });
            }
          } catch {
            // ignore tab detection errors
          }
        }

        const result: Record<string, unknown> = {
          navigated: navigated ?? false,
          ...(typeof response?.data === "object" && response?.data !== null ? response.data : {}),
        };
        if (needCurrent) {
          result.currentTab = afterInfo;
        }
        if (needIframe) {
          const iframeChanges = beforeInfo && afterInfo
            ? diffIframes(beforeInfo.iframes, afterInfo.iframes)
            : [];
          if (iframeChanges.length > 0) result.iframeChanges = iframeChanges;
        }
        if (needNewTabs && newTabInfos.length > 0) result.newTabs = newTabInfos;

        sendResult({
          commandId: cmd.id!,
          success: response?.success ?? false,
          data: result,
          error: response?.error,
        });
      } else {
        sendResult({
          commandId: cmd.id!,
          success: response?.success ?? false,
          data: response?.data,
          error: response?.error,
        });
      }
      onDone?.();
    });
  }

  doSend(tabId);
}

interface FullPageInfo {
  url: string;
  title: string;
  iframes: { index: number; src: string; sameOrigin: boolean; url?: string }[];
  jsErrors?: { message: string; source: string; lineno?: number }[];
}

async function getFullPageInfo(tabId: number, cmdParams?: Record<string, unknown>): Promise<FullPageInfo | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== "complete" || !tab.url) {
      await waitForTabLoad(tabId);
    }
    const t = await chrome.tabs.get(tabId);
    const result: FullPageInfo = {
      url: t.url || "",
      title: t.title || "",
      iframes: [],
    };

    // 将 currentTab.xxx 映射为 xxx 传给 content script
    const fields = (cmdParams as Record<string, string[]> | undefined)?._field || [];
    const mappedFields = fields.map(f => f.replace(/^currentTab\./, ""));
    const needContentScript = mappedFields.some(f => f === "iframes" || f === "html" || f === "jsErrors");

    if (needContentScript) {
      await waitForTabLoad(tabId);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 300));
        const resp = await new Promise<{ data?: FullPageInfo }>((resolve) => {
          const timer = setTimeout(() => resolve({}), 2000);
          chrome.tabs.sendMessage(tabId, {
            type: "execute_command",
            payload: { command: "get_page_info", params: { _field: mappedFields } },
          }, (r) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) return resolve({});
            resolve(r as { data?: FullPageInfo });
          });
        });
        if (resp.data?.iframes && resp.data.iframes.length > 0) {
          result.iframes = resp.data.iframes;
          break;
        }
      }
    }

    // 根据 _field 过滤返回字段
    if (fields.length > 0) {
      const filtered: Record<string, unknown> = {};
      const hasField = (name: string) => fields.some(f => f === name || f === `currentTab.${name}`);
      if (hasField("url")) filtered.url = result.url;
      if (hasField("title")) filtered.title = result.title;
      if (hasField("iframes")) filtered.iframes = result.iframes;
      if (hasField("html")) filtered.html = result.html;
      return filtered as FullPageInfo;
    }

    return result;
  } catch {
    return null;
  }
}

function diffIframes(
  before: FullPageInfo["iframes"],
  after: FullPageInfo["iframes"],
): { index: number; srcChanged: boolean; beforeSrc: string; afterSrc: string }[] {
  const beforeMap = new Map(before.map((f) => [f.index, f]));
  const afterMap = new Map(after.map((f) => [f.index, f]));
  const changes: { index: number; srcChanged: boolean; beforeSrc: string; afterSrc: string }[] = [];

  const allIndices = new Set([...beforeMap.keys(), ...afterMap.keys()]);
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

function waitForTabLoad(tabId: number, timeoutMs = 30000): Promise<void> {
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
      const listener = (tid: number, info: chrome.tabs.TabChangeInfo) => {
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

/**
 * Inject the content script into a tab that doesn't have one loaded.
 * Uses chrome.scripting.executeScript to dynamically inject the handler.
 * Waits for the injected code to signal readiness before resolving.
 */
async function injectContentScript(tabId: number): Promise<void> {
  const INJECT_TIMEOUT = 5000;
  // Listen for the "cs_injected" readiness signal from the injected code
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error(`Content script injection timed out after ${INJECT_TIMEOUT}ms`));
    }, INJECT_TIMEOUT);

    const listener = (_msg: { type: string }) => {
      if (_msg.type === "cs_injected") {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Self-contained content script injected into the page
      (() => {
        chrome.runtime.onMessage.addListener(
          (
            msg: { type: string; id?: string; payload: { command: string; params?: Record<string, unknown> } },
            _sender: chrome.runtime.MessageSender,
            sendResponse: (res: { success: boolean; data?: unknown; error?: string }) => void,
          ) => {
            if (msg.type !== "execute_command") return;
            const { command } = msg.payload;
            const exec = () => handleCommand(msg.payload);
            exec().then(sendResponse);
            return true;
          },
        );

        // Persistent JS error collection (starts on page load)
        const jsErrors: { message: string; source: string; lineno?: number }[] = [];
        window.addEventListener("error", (ev: ErrorEvent) => {
          jsErrors.push({ message: ev.message, source: ev.filename, lineno: ev.lineno });
        });
        window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
          const reason = ev.reason;
          const msg = typeof reason === "string" ? reason : reason?.message ?? String(reason);
          jsErrors.push({ message: `Unhandled rejection: ${msg}`, source: "unhandledrejection" });
        });

        // Signal readiness to the service worker
        chrome.runtime.sendMessage({ type: "cs_injected" }).catch(() => {});

        async function handleCommand(
          _id: string,
          payload: { command: string; params?: Record<string, unknown> },
        ): Promise<{ success: boolean; data?: unknown; error?: string }> {
          const { command, params = {} } = payload;
          try {
            switch (command) {
              case "click": {
                let el: Element;
                let clickDesc: Record<string, unknown> = {};
                if (params.text) {
                  const text = params.text as string;
                  const found = findByText(text);
                  if (!found) return { success: false, error: `No element found with text: ${text}` };
                  el = found;
                  clickDesc = { text, tag: (el as HTMLElement).tagName.toLowerCase() };
                  (el as HTMLElement).click();
                } else if (params.x !== undefined && params.y !== undefined) {
                  const x = params.x as number;
                  const y = params.y as number;
                  const found = document.elementFromPoint(x, y);
                  if (!found) return { success: false, error: `No element at (${x}, ${y})` };
                  el = found;
                  clickDesc = { x, y, tag: (el as HTMLElement).tagName.toLowerCase() };
                  el.dispatchEvent(new MouseEvent("click", {
                    bubbles: true, cancelable: true, clientX: x, clientY: y, view: window,
                  }));
                } else {
                  const selector = params.selector as string;
                  if (!selector) return { success: false, error: "Need text, selector, or {x,y}" };
                  const found = findElement(selector);
                  if (!found) return { success: false, error: `Element not found: ${selector}` };
                  el = found;
                  clickDesc = { selector, tag: (el as HTMLElement).tagName.toLowerCase() };
                  (el as HTMLElement).click();
                }
                let navigated = false;
                const onBeforeUnload = () => { navigated = true; };
                window.addEventListener("beforeunload", onBeforeUnload, { once: true });
                await new Promise((r) => setTimeout(r, 300));
                window.removeEventListener("beforeunload", onBeforeUnload);
                return { success: true, navigated, data: clickDesc };
              }
              case "type": {
                const selector = params.selector as string;
                const text = params.text as string;
                const el = findElement(selector) as HTMLInputElement | HTMLTextAreaElement | null;
                if (!el) return { success: false, error: `Element not found: ${selector}` };
                el.value = text;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                return { success: true };
              }
              case "get_text": {
                const selector = params.selector as string;
                const el = selector ? findElement(selector) : document.body;
                if (!el) return { success: false, error: `Element not found: ${selector}` };
                return { success: true, data: el.textContent?.trim() };
              }
              case "get_page_info": {
                const fields = ((params as Record<string, string[]> | undefined)._field) || [];
                const data: Record<string, unknown> = {};
                if (fields.length === 0 || fields.includes("url")) data.url = window.location.href;
                if (fields.length === 0 || fields.includes("title")) data.title = document.title;
                if (fields.length === 0 || fields.includes("html")) data.html = document.documentElement.outerHTML;
                if (fields.length === 0 || fields.includes("iframes")) {
                  const iframes: { index: number; src: string; sameOrigin: boolean; url?: string; html?: string }[] = [];
                  document.querySelectorAll("iframe").forEach((f, i) => {
                    const iframe = f as HTMLIFrameElement;
                    let sameOrigin = false;
                    let url: string | undefined;
                    let html: string | undefined;
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
                    iframes.push({ index: i, src: iframe.src, sameOrigin, ...(sameOrigin ? { url, html } : {}) });
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
                const timeout = (params.timeout as number) ?? 10000;
                const start = Date.now();
                // Poll every 200ms for readyState === 'complete'
                return new Promise<{ success: boolean; data: { readyState: string; elapsed: number } }>((resolve) => {
                  const CHECK_INTERVAL = 200;
                  let timer: number;
                  const check = () => {
                    const elapsed = Date.now() - start;
                    if (elapsed >= timeout) {
                      cleanup();
                      resolve({ success: true, data: { readyState: document.readyState, elapsed } });
                      return;
                    }
                    if (document.readyState === "complete") {
                      cleanup();
                      // Wait for DOM to settle after readyState complete
                      waitForDomSettle(Math.min(timeout - (Date.now() - start), 3000)).then(() => {
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
                const y = (params.y as number) ?? 0;
                const x = (params.x as number) ?? 0;
                window.scrollTo({ top: y, left: x, behavior: "smooth" });
                await waitForDomStable(3000);
                return { success: true, data: { scrollX: window.scrollX, scrollY: window.scrollY } };
              }
              default:
                return { success: false, error: `Unknown command: ${command}` };
            }
          } catch (err) {
            return { success: false, error: String(err) };
          }
        }

        function waitForDomStable(maxWaitMs: number): Promise<void> {
          return new Promise((resolve) => {
            let quietTimer: number;
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

        function waitForDomSettle(maxWaitMs: number): Promise<void> {
          return new Promise((resolve) => {
            const INTERVAL = 200;
            const QUIET_MS = 500;
            let lastHtml = document.body.innerHTML;
            let stableSince = Date.now();
            let timer: number;

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

        function findByText(text: string): Element | null {
          const q = xpathStr(text);
          const hidden = "self::script or self::style or self::noscript or self::template or self::head or self::title or self::meta or self::svg or self::path";
          const xpath = [
            `//body//button[contains(normalize-space(.), ${q})]`,
            `//body//a[contains(normalize-space(.), ${q})]`,
            `//body//input[contains(@value, ${q})]`,
            `//body//*[not(${hidden})][contains(normalize-space(.), ${q}) and not(./*[not(${hidden})][contains(normalize-space(.), ${q})])]`,
          ].join(" | ");
          const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
          let el = result.iterateNext();
          while (el) {
            const htmlEl = el as HTMLElement;
            if (isVisible(htmlEl)) return htmlEl;
            el = result.iterateNext();
          }
          return null;
        }

        function isVisible(el: HTMLElement): boolean {
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function xpathStr(s: string): string {
          if (!s.includes("'")) return `'${s}'`;
          if (!s.includes('"')) return `"${s}"`;
          return "concat('" + s.replace(/'/g, "',\"'\",'") + "')";
        }

        function findElement(selector: string): Element | null {
          if (selector.startsWith("css:")) {
            return document.querySelector(selector.slice(4));
          }
          if (selector.startsWith("xpath:")) {
            const xpath = selector.slice(6);
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            return result.singleNodeValue as Element | null;
          }
          return document.querySelector(selector);
        }
      })();
    },
  });

  // Wait for the injected code to register its listener and confirm readiness
  await ready;
}

async function getOrCreateGroup(windowId: number): Promise<number | null> {
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
    groupId = existing[0].id!;
    groupWindowId = windowId;
    return groupId;
  }

  return null;
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

  function sendResult(payload: { commandId: string; success: boolean; data?: unknown; error?: string }): void {
    wsClient.send({ type: "command_result", payload: { ...payload, data: payload.data } });
  }

  try {
    switch (command) {
      case "open": {
        const url = (params.url as string) || "about:blank";
        const tab = await chrome.tabs.create({ url });
        const gid = await getOrCreateGroup(tab.windowId!);
        if (gid == null) {
          groupId = await chrome.tabs.group({ tabIds: [tab.id!] });
          groupWindowId = tab.windowId!;
          await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "grey" });
        } else {
          await chrome.tabs.group({ tabIds: tab.id!, groupId: gid });
        }
        const fullInfo = await getFullPageInfo(tab.id!, params as Record<string, string[]> | undefined);
        sendResult({
          commandId: cmd.id!,
          success: true,
          data: fullInfo,
        });
        break;
      }

      case "list_tabs": {
        const tabs = await chrome.tabs.query({});
        sendResult({
          commandId: cmd.id!,
          success: true,
          data: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
        });
        break;
      }

      case "close_tab": {
        let tabId: number;
        if (params.tabId === "current") {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tabs[0]?.id) {
            sendResult({ commandId: cmd.id!, success: false, error: "No active tab" });
            return;
          }
          tabId = tabs[0].id;
        } else {
          tabId = params.tabId as number;
        }
        if (tabId == null) {
          sendResult({ commandId: cmd.id!, success: false, error: "Missing tabId parameter" });
          return;
        }
        tabQueues.delete(tabId);
        await chrome.tabs.remove(tabId);
        cleanupGroupIfEmpty();
        sendResult({ commandId: cmd.id!, success: true, data: { tabId } });
        break;
      }

      default:
        sendResult({ commandId: cmd.id!, success: false, error: `Unknown browser command: ${command}` });
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
