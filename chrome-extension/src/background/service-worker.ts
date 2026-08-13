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
const BROWSER_COMMANDS = new Set(["open", "list_tabs", "close_tab", "refresh"]);

// Commands that need a real trusted click via chrome.debugger
const REAL_CLICK_COMMANDS = new Set(["real_click", "screenshot"]);

// CDP 模拟鼠标的当前位置（跨调用保留，模拟真实鼠标在页面上的持续位置）
let lastMouseX = 0;
let lastMouseY = 0;

// 从当前模拟鼠标位置渐进移动到目标点：分小步连续移动，触发途经元素的
// mouseover/mouseenter（真实 hover 链）。瞬移（单次 mouseMoved）不会触发
// weui popover 等依赖逐级 hover 的组件。
async function moveMouseInSteps(tabId: number, tx: number, ty: number): Promise<void> {
  const dx = tx - lastMouseX;
  const dy = ty - lastMouseY;
  const dist = Math.max(Math.abs(dx), Math.abs(dy));
  const steps = Math.max(1, Math.ceil(dist / 10));
  for (let i = 1; i <= steps; i++) {
    const px = Math.round(lastMouseX + (dx * i) / steps);
    const py = Math.round(lastMouseY + (dy * i) / steps);
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: px, y: py, button: "none",
    });
    await new Promise((r) => setTimeout(r, 15));
  }
  lastMouseX = tx;
  lastMouseY = ty;
}

// Commands that exist in content script but are not exposed via remote control
const BLOCKED_COMMANDS = new Set(["wait_for_page"]);

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

  if (BLOCKED_COMMANDS.has(cmd.payload.command)) {
    wsClient.send({
      type: "command_result",
      payload: { commandId: cmd.id!, success: false, error: `Command "${cmd.payload.command}" is not available` },
    });
    return;
  }

  if (REAL_CLICK_COMMANDS.has(cmd.payload.command)) {
    handleRealClick(cmd);
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
  (msg: { type: string }, _sender: chrome.runtime.MessageSender, sendResponse: (res: Record<string, unknown>) => void) => {
    // 内容脚本就绪信号（动态注入后，或 manifest all_frames 注入时都会发）。
    // 立即响应并关闭消息通道，不进入下面 return true 的异步保活。
    if (msg.type === "cs_injected") {
      sendResponse({ ok: true });
      return;
    }
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

async function sendToTab(
  tabId: number,
  cmd: CommandMessage,
  params: Record<string, unknown>,
  onDone?: () => void,
): Promise<void> {
  const command = cmd.payload.command;
  const isClick = command === "click";
  const fieldFilter = ((cmd.payload.params as Record<string, string[]> | undefined)?._field) || [];
  const needCurrent = fieldFilter.length === 0 || fieldFilter.some(f => f === "currentTab" || f.startsWith("currentTab."));
  const needIframe = fieldFilter.length === 0 || fieldFilter.some(f => f === "iframeChanges" || f.startsWith("iframeChanges."));
  const needNewTabs = fieldFilter.length === 0 || fieldFilter.some(f => f === "newTabs" || f.startsWith("newTabs."));
  const needBeforeInfo = isClick && needIframe;

  const sendResult = (payload: { commandId: string; success: boolean; data?: unknown; error?: string }): void => {
    wsClient.send({ type: "command_result", payload: { ...payload, data: payload.data } });
  };

  // before 信息（新标签检测需要 beforeTabs；click+iframeChanges 需要 beforeFullInfo）
  let beforeTabs: chrome.tabs.Tab[] = [];
  let beforeFullInfo: FullPageInfo | null = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (needBeforeInfo || needNewTabs) {
      beforeTabs = await chrome.tabs.query({ windowId: tab.windowId! });
    }
    if (needBeforeInfo) {
      beforeFullInfo = await getFullPageInfo(tabId, cmd.payload.params as Record<string, string[]> | undefined);
    }
  } catch {
    // 预读失败不阻断命令
  }

  const msg = { type: "execute_command", id: cmd.id, payload: { command, params } };

  // 特殊命令：jsErrors 广播聚合；clear_js_errors 广播；hide 各 frame 各自还原；
  // get_page_info 走 SW 侧（含跨域 iframe 元数据补全）
  if (command === "get_js_errors") {
    const data = await broadcastJsErrors(tabId);
    sendResult({ commandId: cmd.id!, success: true, data });
    onDone?.();
    return;
  }
  if (command === "clear_js_errors") {
    await broadcastClearJsErrors(tabId);
    sendResult({ commandId: cmd.id!, success: true, data: {} });
    onDone?.();
    return;
  }
  if (command === "hide") {
    const frames = await getFrameTree(tabId);
    let count = 0;
    for (const f of frames) {
      const { response } = await sendToFrame(tabId, f.frameId, msg);
      count += (response?.data as { count?: number } | undefined)?.count ?? 0;
    }
    sendResult({ commandId: cmd.id!, success: true, data: { count } });
    onDone?.();
    return;
  }
  if (command === "get_page_info") {
    const info = await getFullPageInfo(tabId, params as Record<string, string[]> | undefined);
    sendResult({ commandId: cmd.id!, success: info != null, data: info ?? undefined, error: info ? undefined : "get_page_info failed" });
    onDone?.();
    return;
  }

  // 坐标 click 只在顶层（elementFromPoint 语义）；其余元素命令按 frame 搜索
  const isCoordinateClick = isClick && params.x !== undefined && params.y !== undefined;
  const searchable = ELEMENT_SEARCH_COMMANDS.has(command) && !isCoordinateClick;

  let response: { success: boolean; data?: unknown; error?: string; notFound?: boolean; navigated?: boolean } | undefined;
  let matchedFrame: SearchFrame | undefined;
  let navigatedFallback = false;

  async function doSearch(): Promise<void> {
    if (!searchable) {
      const r = await sendToFrame(tabId, 0, msg);
      response = r.response;
      return;
    }
    const frames = await resolveSearchFrames(tabId, params.frame);
    for (const f of frames) {
      const r = await sendToFrame(tabId, f.frameId, msg);
      if (r.missing) {
        // 点击导致该 frame 导航：端口关闭、无响应 → 按「已点击 + 导航」处理
        if (isClick) { navigatedFallback = true; matchedFrame = f; break; }
        continue;
      }
      if (r.response?.notFound) continue;
      response = r.response;
      matchedFrame = f;
      break;
    }
  }

  // 若没有任何 frame 有 content script（动态 frame / 页面加载前）：注入一次后重试
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

  const frameAttribution = matchedFrame
    ? { frame: { frameId: matchedFrame.frameId, url: matchedFrame.url } }
    : {};

  try {
    const wasNavigated = navigatedFallback || (response?.data as { navigated?: boolean } | undefined)?.navigated === true;
    if (wasNavigated) {
      // 页面/iframe 跳转：取新页面信息
      const currentInfo = needCurrent
        ? await getFullPageInfo(tabId, cmd.payload.params as Record<string, string[]> | undefined)
        : null;
      const navResult: Record<string, unknown> = { navigated: true };
      if (needCurrent) navResult.currentTab = currentInfo;
      if (needNewTabs) {
        const newTabInfos = await collectNewTabs(tabId, beforeTabs, cmd.payload.params as Record<string, string[]> | undefined);
        if (newTabInfos.length > 0) navResult.newTabs = newTabInfos;
      }
      sendResult({ commandId: cmd.id!, success: true, data: navResult });
      onDone?.();
      return;
    }

    if (isClick) {
      const afterInfo = needCurrent
        ? await getFullPageInfo(tabId, cmd.payload.params as Record<string, string[]> | undefined)
        : null;
      let newTabInfos: NewTabInfo[] = [];
      if (needNewTabs) {
        try { newTabInfos = await collectNewTabs(tabId, beforeTabs, cmd.payload.params as Record<string, string[]> | undefined); } catch { /* ignore */ }
      }
      const result: Record<string, unknown> = {
        navigated: false,
        ...(typeof response?.data === "object" && response?.data !== null ? response.data : {}),
        ...frameAttribution,
      };
      if (needCurrent) result.currentTab = afterInfo;
      if (needIframe) {
        const iframeChanges = beforeFullInfo && afterInfo
          ? diffIframes(beforeFullInfo.iframes, afterInfo.iframes)
          : [];
        if (iframeChanges.length > 0) result.iframeChanges = iframeChanges;
      }
      if (needNewTabs && newTabInfos.length > 0) result.newTabs = newTabInfos;
      sendResult({ commandId: cmd.id!, success: response?.success ?? false, data: result, error: response?.error });
      onDone?.();
      return;
    }

    // 常规命令：透传数据 + 命中 frame 归属
    const data = (typeof response?.data === "object" && response?.data !== null && !Array.isArray(response.data))
      ? { ...(response.data as Record<string, unknown>), ...frameAttribution }
      : response?.data;
    sendResult({ commandId: cmd.id!, success: response?.success ?? false, data, error: response?.error });
    onDone?.();
  } catch (err) {
    sendResult({ commandId: cmd.id!, success: false, error: String(err) });
    onDone?.();
  }
}

type NewTabInfo = { tabId: number; url: string; title: string; iframes: FullPageInfo["iframes"] };

async function collectNewTabs(tabId: number, beforeTabs: chrome.tabs.Tab[], cmdParams?: Record<string, unknown>): Promise<NewTabInfo[]> {
  const beforeIds = new Set(beforeTabs.map((t) => t.id));
  try {
    const currentTab = await chrome.tabs.get(tabId);
    const afterTabs = await chrome.tabs.query({ windowId: currentTab.windowId! });
    const newTabIds: number[] = afterTabs.filter((t) => t.id != null && !beforeIds.has(t.id)).map((t) => t.id as number);
    const out: NewTabInfo[] = [];
    for (const ntid of newTabIds) {
      try { await waitForTabLoad(ntid); } catch { continue; }
      const info = await getFullPageInfo(ntid, cmdParams);
      if (info) out.push({ tabId: ntid, ...info });
    }
    return out;
  } catch {
    return [];
  }
}


interface IframeMeta {
  index: number;
  src: string;
  sameOrigin: boolean;
  url?: string;
  html?: string;
}

interface FullPageInfo {
  url: string;
  title: string;
  iframes: IframeMeta[];
  html?: string;
  jsErrors?: { message: string; source: string; lineno?: number }[];
}

// 需要在每个 frame 中查找元素的命令（首个命中即返回；坐标 click / scroll 只在顶层）
const ELEMENT_SEARCH_COMMANDS = new Set(["click", "type", "get_text", "get_css", "show", "upload_file", "paste_rich", "get_rect"]);

interface SearchFrame {
  frameId: number;
  parentFrameId: number;
  url: string;
  depth: number;
  order: number;
}

// 短 TTL 的 frame 树缓存（按 tabId）：同一命令内多次枚举不重复调 webNavigation；
// tab 导航后（onUpdated status=complete）失效。
const frameTreeCache = new Map<number, { at: number; frames: SearchFrame[] }>();

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete") frameTreeCache.delete(tabId);
});

async function getFrameTree(tabId: number): Promise<SearchFrame[]> {
  const cached = frameTreeCache.get(tabId);
  if (cached && Date.now() - cached.at < 500) return cached.frames;
  let frames: SearchFrame[] = [];
  try {
    const all = await chrome.webNavigation.getAllFrames({ tabId });
    if (all && all.length > 0) {
      const byId = new Map(all.map((f) => [f.frameId, f]));
      const depthOf = new Map<number, number>();
      const depth = (frameId: number): number => {
        const cachedD = depthOf.get(frameId);
        if (cachedD != null) return cachedD;
        const f = byId.get(frameId);
        const d = f && f.parentFrameId != null && f.parentFrameId !== -1
          ? depth(f.parentFrameId) + 1
          : 0;
        depthOf.set(frameId, d);
        return d;
      };
      // 顶层优先（depth 小）、同层保持 getAllFrames 数组序（近似 DOM 顺序）
      frames = all
        .map((f, i) => ({
          frameId: f.frameId,
          parentFrameId: f.parentFrameId ?? -1,
          url: f.url || "",
          depth: depth(f.frameId),
          order: i,
        }))
        .sort((a, b) => a.depth - b.depth || a.order - b.order);
    }
  } catch {
    // getAllFrames 失败（如浏览器内建页）：退化为只顶层
  }
  if (frames.length === 0) {
    frames = [{ frameId: 0, parentFrameId: -1, url: "", depth: 0, order: 0 }];
  }
  frameTreeCache.set(tabId, { at: Date.now(), frames });
  return frames;
}

// 向指定 frame 发消息的 Promise 封装：无 listener / 端口关闭（如 frame 刚导航走）视为 missing
function sendToFrame(
  tabId: number,
  frameId: number,
  msg: Record<string, unknown>,
  timeoutMs = 1200,
): Promise<{
  response?: { success: boolean; data?: unknown; error?: string; notFound?: boolean; navigated?: boolean };
  missing?: boolean;
}> {
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
          response: r as { success: boolean; data?: unknown; error?: string; notFound?: boolean; navigated?: boolean },
        });
      });
    } catch {
      clearTimeout(timer);
      resolve({ missing: true });
    }
  });
}

// 顶层 frame 的 iframes 元数据（index↔src，跨域条目也带 src）
async function getTopIframes(tabId: number): Promise<IframeMeta[]> {
  const { response } = await sendToFrame(tabId, 0, {
    type: "execute_command",
    payload: { command: "get_page_info", params: { _field: ["iframes"] } },
  });
  return (response?.data as { iframes?: IframeMeta[] } | undefined)?.iframes ?? [];
}

// frame 参数 → 搜索范围：
//   "top"           仅顶层
//   数字 n          顶层 iframe 序号（用 iframes 的 index↔src 关联到 frameId）
//   {url:"子串"}    按 URL 子串匹配首个 frame（跨域最稳，推荐）
//   缺省 / "auto"   全 frame（顶层优先深度优先）
async function resolveSearchFrames(tabId: number, frameParam: unknown): Promise<SearchFrame[]> {
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
    const urlSub = (frameParam as { url?: string }).url;
    if (urlSub) {
      const hit = frames.find((f) => f.url && f.url.includes(urlSub));
      return hit ? [hit] : [];
    }
  }
  return frames;
}

// 顶层 collectIframes 只含同源 url/html；跨域条目用「src ↔ getAllFrames.url」关联到
// 子 frameId，再调 frame_info 补全 url/html
async function enrichCrossOriginIframes(tabId: number, iframes: IframeMeta[], needHtml: boolean): Promise<IframeMeta[]> {
  if (!iframes.some((f) => !f.sameOrigin)) return iframes;
  const frames = await getFrameTree(tabId);
  const childFrames = frames.filter((f) => f.parentFrameId === 0);
  const used = new Set<number>();
  const out: IframeMeta[] = [];
  for (const ifr of iframes) {
    if (ifr.sameOrigin) {
      out.push(ifr);
      continue;
    }
    // 优先按 src 关联；失败则按顺序取下一个未匹配的子 frame
    let match = childFrames.find((cf) => !used.has(cf.frameId) && ifr.src && cf.url && (cf.url === ifr.src || cf.url.startsWith(ifr.src)));
    if (!match) match = childFrames.find((cf) => !used.has(cf.frameId));
    if (match) {
      used.add(match.frameId);
      const { response } = await sendToFrame(tabId, match.frameId, {
        type: "execute_command",
        payload: { command: "frame_info", params: {} },
      });
      const d = response?.data as { url?: string; title?: string; html?: string } | undefined;
      out.push({
        index: ifr.index,
        src: ifr.src,
        sameOrigin: false,
        ...(d?.url ? { url: d.url } : {}),
        ...(needHtml && d?.html ? { html: d.html } : {}),
      });
    } else {
      out.push(ifr);
    }
  }
  return out;
}

// get_js_errors / clear_js_errors：广播到所有 frame，聚合时给错误标注来源 frame url
async function broadcastJsErrors(tabId: number): Promise<{ errors: { message: string; source: string; lineno?: number; frame?: string }[]; count: number }> {
  const frames = await getFrameTree(tabId);
  const errors: { message: string; source: string; lineno?: number; frame?: string }[] = [];
  for (const f of frames) {
    const { response } = await sendToFrame(tabId, f.frameId, {
      type: "execute_command",
      payload: { command: "get_js_errors", params: {} },
    });
    const errs = (response?.data as { errors?: { message: string; source: string; lineno?: number }[] })?.errors;
    if (Array.isArray(errs)) {
      for (const e of errs) errors.push({ ...e, ...(f.frameId !== 0 ? { frame: f.url } : {}) });
    }
  }
  return { errors, count: errors.length };
}

async function broadcastClearJsErrors(tabId: number): Promise<void> {
  const frames = await getFrameTree(tabId);
  for (const f of frames) {
    await sendToFrame(tabId, f.frameId, {
      type: "execute_command",
      payload: { command: "clear_js_errors", params: {} },
    });
  }
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
    const needIframes = fields.length === 0 || fields.some(f => f === "iframes" || f === `currentTab.iframes`);

    if (needContentScript) {
      await waitForTabLoad(tabId);
      let iframes: IframeMeta[] | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 100));
        const { response } = await sendToFrame(tabId, 0, {
          type: "execute_command",
          payload: { command: "get_page_info", params: { _field: mappedFields } },
        });
        const data = response?.data as { iframes?: IframeMeta[] } | undefined;
        if (data?.iframes && data.iframes.length > 0) {
          iframes = data.iframes;
          break;
        }
      }
      if (iframes) {
        // 跨域 iframe 顶层读不到内容，用子 frame 自报补全 url/html
        result.iframes = await enrichCrossOriginIframes(tabId, iframes, needIframes);
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
      return filtered as unknown as FullPageInfo;
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
 * Uses chrome.scripting.executeScript to dynamically inject the packaged
 * content-script.js into every frame (all_frames: true), so iframe content
 * is available even for frames inserted after the page's initial load.
 * Waits for the injected code to signal readiness (cs_injected) before resolving.
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

  // 动态注入打包好的 content-script.js（单一事实来源，与 manifest all_frames 注入同一份文件）
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content/content-script.js"],
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

      case "refresh": {
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
        await chrome.tabs.reload(tabId);
        await waitForTabLoad(tabId);
        sendResult({ commandId: cmd.id!, success: true });
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

/**
 * real_click: 通过 chrome.debugger 发送完整真实鼠标事件（isTrusted=true），
 * 解决微信后台等对合成 click 免疫的 Vue/React 组件点击问题。
 * 事件链：mouseMoved（触发 mouseover/mouseenter/hover）-> mousePressed(mousedown) -> mouseReleased(mouseup+click)。
 * 流程：content script 获取元素中心坐标（iframe 内同源自动换算为顶层坐标；跨域走 CDP 定位）
 *      -> debugger 附加页面 -> Input.dispatchMouseEvent 发送完整序列。
 */
async function handleRealClick(cmd: CommandMessage): Promise<void> {
  const params = cmd.payload.params || {};
  const tabId = params.tabId as number | undefined;
  const selector = params.selector as string;
  // approach: 渐进移动路径 [[x,y],...]，模拟真实鼠标轨迹逐级触发 hover
  const approach = params.approach as [number, number][] | undefined;

  function sendResult(payload: { success: boolean; data?: unknown; error?: string }): void {
    wsClient.send({ type: "command_result", payload: { commandId: cmd.id!, ...payload } });
  }

  try {
    if (tabId == null) {
      sendResult({ success: false, error: "Missing tabId parameter" });
      return;
    }

    // screenshot: 通过 CDP Page.captureScreenshot 截取当前页面（只读，不注入代码）
    if (cmd.payload.command === "screenshot") {
      await chrome.debugger.attach({ tabId }, "1.3");
      try {
        const result = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
          format: "png",
        }) as { data?: string };
        sendResult({ success: true, data: result?.data ?? null });
      } finally {
        await chrome.debugger.detach({ tabId }).catch(() => {});
      }
      return;
    }

    // 1. 确定点击目标坐标：优先直接 x/y；否则按 frame 搜索定位元素。
    //    同源 iframe：get_rect 已换算顶层视口坐标；跨域 iframe：get_rect 标记 crossOrigin，
    //    记下 frameId，附加 debugger 后用 CDP getContentQuads 精确定位。
    let x = params.x as number | undefined;
    let y = params.y as number | undefined;
    let cdpFrameId: number | undefined;
    if (x == null || y == null) {
      const frames = await resolveSearchFrames(tabId, params.frame);
      for (const f of frames) {
        const r = await sendToFrame(tabId, f.frameId, {
          type: "execute_command",
          payload: { command: "get_rect", params: { selector } },
        }, 8000);
        if (r.missing || r.response?.notFound) continue;
        const d = r.response?.data as { x?: number; y?: number; crossOrigin?: boolean } | undefined;
        if (d?.crossOrigin) {
          cdpFrameId = f.frameId;
          break;
        }
        x = d?.x;
        y = d?.y;
        break;
      }
    }
    if (x == null || y == null) {
      sendResult({ success: false, error: `Could not locate element: ${selector || "unknown"}` });
      return;
    }

    // 2. 附加 debugger
    await chrome.debugger.attach({ tabId }, "1.3");
    try {
      // 2.1 跨域 iframe：CDP 在目标 frame 上下文里定位元素中心（顶层视口坐标）
      if (cdpFrameId != null) {
        const point = await getElementCenterViaCdp(tabId, cdpFrameId, params);
        if (!point) {
          sendResult({ success: false, error: `Could not locate element in iframe via CDP: ${selector}` });
          return;
        }
        x = point.x;
        y = point.y;
      }
      // 2.2 激活窗口和标签页（CDP 鼠标事件需要窗口在前台才触发页面交互）
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId != null) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        await chrome.tabs.update(tabId, { active: true });
      } catch {
        // 窗口激活失败不阻断，继续尝试点击
      }
      // 3. 发送完整真实鼠标事件序列（模拟真实物理点击的事件链）
      //    真实点击：mouseover/mouseenter（由 mouseMoved 触发）-> mousedown -> mouseup -> click
      //    CDP 的 mousePressed+mouseReleased 会自动产生 click，无需显式发 click
      const clickPoint = { x, y, button: "left" as const, clickCount: 1 };

      // 3.0 渐进移动到 approach 路径各点（模拟真实鼠标轨迹，逐级触发 hover）
      if (approach && approach.length) {
        for (const [ax, ay] of approach) {
          await moveMouseInSteps(tabId, ax, ay);
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      // 3.1 鼠标渐进移动到元素中心（触发 mouseover/mouseenter/mousemove，激活 hover 状态）
      await moveMouseInSteps(tabId, x, y);
      // 3.2 短暂停留，让 hover/样式生效（有 approach 时等 popover 展开）
      await new Promise((r) => setTimeout(r, approach && approach.length ? 400 : 120));
      // 3.3 按下（触发 mousedown + focus）
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed", ...clickPoint,
      });
      // 3.4 松开（触发 mouseup，浏览器自动合成 click）
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased", ...clickPoint,
      });
      // 鼠标保持在目标上（不移开），保留 hover 状态供后续操作（如点击 hover 工具条子项）
    } finally {
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }

    sendResult({ success: true, data: { x, y, trusted: true } });
  } catch (err) {
    sendResult({ success: false, error: String(err) });
  }
}

/**
 * 跨域 iframe 内元素定位：顶层 content script 无法读其坐标（getBoundingClientRect 越权），
 * 用 CDP 在目标 frame 的 JS 上下文里定位元素，再 DOM.getContentQuads 取顶层视口中心坐标。
 * 必须在 debugger 已 attach 时调用。
 */
async function getElementCenterViaCdp(
  tabId: number,
  frameId: number,
  params: Record<string, unknown>,
): Promise<{ x: number; y: number } | null> {
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");

  // 收集 execution contexts（Runtime.enable 会重放已存在的 context 创建事件），
  // 选目标 frame 的默认主世界 context
  const contexts: { id: number; frameId?: string; isDefault?: boolean }[] = [];
  const onEvent = (_src: chrome.debugger.Debuggee, method: string, eventParams?: object) => {
    if (method === "Runtime.executionContextCreated") {
      const ctx = (eventParams as { context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } } } | undefined)?.context;
      if (ctx?.id != null) {
        contexts.push({
          id: ctx.id,
          frameId: ctx.auxData?.frameId,
          isDefault: ctx.auxData?.isDefault,
        });
      }
    }
  };
  chrome.debugger.onEvent.addListener(onEvent);
  await new Promise((r) => setTimeout(r, 300));
  chrome.debugger.onEvent.removeListener(onEvent);

  const ctx = contexts.find((c) => c.isDefault && c.frameId === String(frameId));
  if (!ctx) return null;

  // 构建查找表达式：与 content script 的 findElement / findByText 语义一致
  const selector = params.selector as string | undefined;
  const text = params.text as string | undefined;
  let expression: string;
  if (text) {
    const q = JSON.stringify(text);
    const hidden = "self::script or self::style or self::noscript or self::template or self::head or self::title or self::meta or self::svg or self::path";
    expression = `(()=>{const xpath=[`//body//button[contains(normalize-space(.),${q})]`,`//body//a[contains(normalize-space(.),${q})]`,`//body//input[contains(@value,${q})]`,`//body//*[not(${hidden})][contains(normalize-space(.),${q}) and not(./*[not(${hidden})][contains(normalize-space(.),${q})])]`].join(" | ");const res=document.evaluate(xpath,document,null,XPathResult.ORDERED_NODE_ITERATOR_TYPE,null);let el=res.iterateNext();while(el){const s=getComputedStyle(el);if(s.display!=="none"&&s.visibility!=="hidden"&&el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0)return el;el=res.iterateNext()}return null})()`;
  } else if ((selector || "").startsWith("xpath:")) {
    const xpath = (selector || "").slice(6);
    expression = `(()=>{const r=document.evaluate(${JSON.stringify(xpath)},document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null);return r.singleNodeValue||null})()`;
  } else {
    const css = (selector || "").replace(/^css:/, "");
    expression = `document.querySelector(${JSON.stringify(css)})`;
  }

  const evalRes = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    contextId: ctx.id,
    expression,
    userGesture: true,
  }) as { result?: { objectId?: string } };
  const objectId = evalRes?.result?.objectId;
  if (!objectId) return null;

  const nodeRes = await chrome.debugger.sendCommand({ tabId }, "DOM.requestNode", { objectId }) as { nodeId?: number };
  const nodeId = nodeRes?.nodeId;
  if (nodeId == null) return null;

  // quads 为顶层视口坐标（含 iframe 偏移与父滚动），取包围盒中心
  const quadsRes = await chrome.debugger.sendCommand({ tabId }, "DOM.getContentQuads", { nodeId }) as { quads?: number[][] };
  const quads = quadsRes?.quads;
  if (!quads || quads.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const quad of quads) {
    for (let i = 0; i < quad.length; i += 2) {
      minX = Math.min(minX, quad[i]); minY = Math.min(minY, quad[i + 1]);
      maxX = Math.max(maxX, quad[i]); maxY = Math.max(maxY, quad[i + 1]);
    }
  }
  if (minX > maxX || minY > maxY) return null;
  return { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) };
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
