/**
 * CDP 元素访问层：写给「页面内所有通道都看不见、但确实可见可点」的子树。
 *
 * 背景（小红书发布页页脚按钮的实测症状）：页脚按钮在一个 closed shadow root 里，
 * content script（隔离世界）拿不到它——`document.querySelector` / XPath / `elementFromPoint`
 * 都到不了，`list_elements` / `get_prop` / `get_text` 一律 notFound。这不是权限问题：
 * 页面自己的 JS 用 `document.querySelector` 同样 notFound（closed shadow root 对页面主世界
 * 也是闭合的），所以「把 exec 常态化」也解决不了——闭包只能从 DOM 协议层穿进去。
 *
 * 本模块是**兜底通道**：只在页面内定位全部失败后才走，命中即返回，常规路径零开销。
 * 调用方负责 attach/detach（`attachDebugger` / `detachDebugger`），本模块只发 CDP 命令。
 *
 * ── 实测确立的协议事实（独立 Chrome + 探针验证，非推断；坐标口径是本模块最易写错的地方）──
 *
 * 1. `DOM.getDocument({depth:-1, pierce:true})` 返回 closed shadow root 节点
 *    （`shadowRootType:"closed"`）及其内部节点与 `backendNodeId`——闭包可遍历。
 * 2. `DOM.getBoxModel` / `DOM.getContentQuads` 的 quad 是**顶层视口坐标 CSS px**
 *    （与 `real_click {"x","y"}` 同口径；元素在 iframe 内时 quad 已含 iframe 偏移与父滚动）。
 * 3. `DOM.getNodeForLocation`（命中测试）吃**页面坐标** = 顶层视口坐标 + 顶层滚动；
 *    传视口坐标会得到 `No node found at given location`。它能穿透 closed shadow root。
 * 4. `DOM.performSearch` 的裸 CSS 查询（`.cls`）能穿透 closed shadow，但会**混入纯文本搜索**
 *    模式（查 `button` 会把 `<script>` 里的文本节点一起返回），因此本模块改走
 *    `DOM.querySelectorAll({nodeId: <root>})`：对顶层文档 / iframe 文档 / open+closed shadow root
 *    各类 root 都精确可用，且结果不含文本节点。
 * 5. pierce **不跨进程**：跨域 iframe（OOPIF）是独立 target，页面会话的 DOM 树里只有
 *    `<iframe>` 宿主元素（实测：宿主页 `#document` 数为 1、跨域内的按钮不在树里；同源 iframe
 *    的 `contentDocument` 则在树里）。这是本版本的覆盖边界。补充实测：OOPIF **有自己的 target
 *    会话**，在那个会话里 `getDocument({pierce:true})` 能拿到它内部 closed shadow root 的按钮
 *    —— 即"够得着但跨会话"，坐标还要再叠一层 OOPIF 在父页里的偏移，未纳入本版本。
 *    边界如实上报（见 `uncoveredIframes`），不静默当作「页面里没有」。
 *
 * 文本匹配 / 可见性 / 交互判定的规则**刻意与 content script 逐条对齐**（findByText / isVisible /
 * list_elements 的候选与 filter 规则）：同一页面两条通道必须给出同一个元素，否则调用方
 * 无法判断「兜底给出的那个」是不是页面内通道会给的那个。
 */

/** 由 service worker 注入的 CDP 发送器（复用其超时与 detach 语义，避免模块反向依赖 SW） */
export type CdpSend = (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

/** debugger 附加不上（DevTools 占用、受限页面等）——区别于「元素不存在」 */
export class CdpUnavailableError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`debugger unavailable: ${detail}`);
    this.name = "CdpUnavailableError";
    this.detail = detail;
  }
}

/**
 * backendNodeId 已解析不到节点：页面在两次调用之间变了（重渲染 / 跳转 / 节点被卸载）。
 * 这类失败必须有明确回执——**最不能容忍的就是它伪装成「点过了但没反应」或「文本就是空的」**：
 * 调用方拿到的 backendNodeId 是上一轮枚举的快照，页面一变就作废，只能重新枚举。
 */
export class StaleNodeError extends Error {
  constructor(backendNodeId: number) {
    super(
      `backendNodeId ${backendNodeId} no longer resolves to a node (page changed — re-run list_elements / get_rect for a fresh id)`,
    );
    this.name = "StaleNodeError";
  }
}

/** 解析节点；解析不到返回 null（由调用方决定上报口径），不让 CDP 的错误直接穿出去 */
async function resolveObjectId(send: CdpSend, backendNodeId: number): Promise<string | null> {
  try {
    const resolved = (await send("DOM.resolveNode", { backendNodeId })) as { object?: { objectId?: string } };
    return resolved?.object?.objectId ?? null;
  } catch {
    return null;
  }
}

/** attach 失败必须转成可识别错误：调用方要把它映射成 `cdp-unavailable`，而不是「元素不存在」 */
export async function attachDebugger(tabId: number): Promise<void> {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    throw new CdpUnavailableError(err instanceof Error ? err.message : String(err));
  }
}

export async function detachDebugger(tabId: number): Promise<void> {
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

/** DOM/Runtime 都得先 enable（重复调用无害） */
export async function enableDomains(send: CdpSend): Promise<void> {
  await send("DOM.enable");
  await send("Runtime.enable");
}

// ─────────────────────────── 树结构 ───────────────────────────

/** 与 content script `findByText` 的 XPath `hidden` 变量同集合 */
const HIDDEN_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "SVG", "PATH"]);

/** list_elements 候选选择器里的交互标签（content script `INTERACTIVE_SELECTOR` 的标签部分） */
const INTERACTIVE_TAGS = new Set(["BUTTON", "A", "SELECT", "TEXTAREA", "INPUT", "LABEL"]);
/** 与 content script `INTERACTIVE_ROLES` 逐项一致 */
const INTERACTIVE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option",
  "combobox", "textbox", "listbox", "slider", "spinbutton", "searchbox",
]);

interface RawNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  shadowRootType?: string;
  children?: RawNode[];
  shadowRoots?: RawNode[];
  contentDocument?: RawNode;
  frameId?: string;
  baseURL?: string;
}

export interface PiercedElement {
  nodeId: number;
  backendNodeId: number;
  /** 小写标签名 */
  tag: string;
  /** 原始大写 nodeName（与 XPath 的 self:: 判定对齐用） */
  nodeName: string;
  attributes: Record<string, string>;
  /** 位于 closed shadow root 内（含嵌套情况：闭包内的 open shadow 也算） */
  inClosedShadowRoot: boolean;
  /**
   * XPath 字符串值口径的文本：自身与全部**同容器**后代的文本节点拼接后折叠空白
   * （不含 shadow 内容——shadow 边界不参与字符串值，与 `normalize-space(.)` 一致）。
   * 注意它**包含 script/style 等隐藏子树里的文字**（XPath 就是这么算的）——
   * 页面把 "发布" 写进内联 JSON 时，`<body>` 的字符串值里就有 "发布"，这个事实要保留，
   * 否则无法解释「页面内通道为什么选中了一个巨大的祖先」。
   */
  text: string;
  /** 同上，但**排除** HIDDEN_TAGS 子树里的文字（= 人眼能看到的文字）；文本查找优先用这个 */
  visibleText: string;
  /** 元素所在的 iframe 文档 URL（顶层文档元素为 undefined） */
  frameUrl?: string;
  /** 所属 shadow root 的类型（"open" / "closed" / "user-agent"；不在 shadow 内则 undefined） */
  shadowRootType?: string;
  /** 有 BODY 祖先（shadow root 内的元素恒为 true——shadow 变体的 XPath 不带 //body// 前缀） */
  inBody: boolean;
  children: PiercedElement[];
}

export interface PiercedRoot {
  kind: "document" | "iframe-document" | "shadow-root";
  nodeId: number;
  backendNodeId: number;
  shadowRootType?: string;
  /** 该 root 自身或其任一祖先 root 是 closed shadow root */
  inClosedShadowRoot: boolean;
  url?: string;
  frameId?: string;
}

/** 本次 pierce 没覆盖到的 iframe 宿主（跨进程 OOPIF / 尚未加载） */
export interface UncoveredIframe {
  /** iframe 的 src 属性原样（可能是相对路径） */
  src: string;
  /** 宿主所在的文档 URL（顶层文档或外层 iframe 文档） */
  inFrameUrl?: string;
}

export interface PiercedTree {
  /** 遍历到的 root：顶层文档 → 各 shadow root / iframe 文档（pre-order） */
  roots: PiercedRoot[];
  /** 全部元素，文档序（pre-order；shadow 内容紧随宿主之后、iframe 文档内容在宿主之后） */
  elements: PiercedElement[];
  byNodeId: Map<number, PiercedElement>;
  byBackendId: Map<number, PiercedElement>;
  closedShadowRoots: number;
  /** 子文档没进这棵树的 iframe——覆盖边界，上层要如实带出，不能表现为「页面里没有」 */
  uncoveredIframes: UncoveredIframe[];
  /** 顶层页面滚动（页面坐标 = 视口坐标 + 该值） */
  scroll: { x: number; y: number };
  viewport: { w: number; h: number };
  dpr: number;
  /**
   * 量这棵树时，附加态视口是否已按判据安定（false = 到上限仍没等到判据要求的状态——几何照常返回，
   * 但调用方该知道这份读数不是"确认过的"）。由 attach 脚手架在取树后填。
   */
  viewportSettled?: boolean;
  /**
   * 是否**观察到 debugger 信息条出现**（= 量到的视口比"没有 debugger 时"矮）。
   * true → 这份几何在附加态空间（配 real_click / 传 backendNodeId 的命令）；
   * false → 信息条没出现，这份几何就是页面内空间（配 get_viewport / click {x,y}）——
   * 两者对底部锚定/vh 类元素差一条信息条的高度（实测 56px），不能混用。undefined = 未探测。
   */
  sawInfobar?: boolean;
  /** 遍历到的节点总数（诊断用） */
  nodeCount: number;
}

function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 文本匹配：**原样**包含 或 **折叠空白后**包含，任一成立即命中（空查询 = 不过滤）。
 * 与 content script 的 textMatches 同规则——用户抄回来的文字可能是原样（含换行/连续空格），
 * 也可能是手写的折叠形式，两种都得能命中。
 */
function textContains(haystack: string, needle: string): boolean {
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  return normalizeSpace(haystack).includes(normalizeSpace(needle));
}

function attrsOf(raw: RawNode): Record<string, string> {
  const out: Record<string, string> = {};
  const a = raw.attributes || [];
  for (let i = 0; i + 1 < a.length; i += 2) out[a[i]] = a[i + 1];
  return out;
}

/**
 * 取整棵 pierce 树 + 页面几何。
 * 单次 `DOM.getDocument({depth:-1, pierce:true})`（实测 qq.com 3224 节点 51ms / 0.8MB，
 * 只在兜底路径调用，按需付这个成本）。
 */
export async function readPiercedTree(send: CdpSend): Promise<PiercedTree> {
  const doc = (await send("DOM.getDocument", { depth: -1, pierce: true }, 15000)) as { root?: RawNode };
  const root = doc?.root;
  if (!root) throw new Error("DOM.getDocument returned no root node");

  const roots: PiercedRoot[] = [];
  const elements: PiercedElement[] = [];
  const byNodeId = new Map<number, PiercedElement>();
  const byBackendId = new Map<number, PiercedElement>();
  const uncoveredIframes: UncoveredIframe[] = [];
  let closedShadowRoots = 0;
  let nodeCount = 0;

  const walkContainer = (container: RawNode, inClosed: boolean, inBody: boolean, frameUrl?: string, shadowRootType?: string): void => {
    for (const c of container.children || []) {
      if (c.nodeType !== 1) continue;
      visit(c, inClosed, inBody, frameUrl, shadowRootType);
    }
  };

  const visit = (
    raw: RawNode,
    inClosed: boolean,
    inBody: boolean,
    frameUrl?: string,
    shadowRootType?: string,
  ): PiercedElement => {
    nodeCount++;
    // 先建壳入列（pre-order = 文档序），子节点访问完再补 text / visibleText
    const el: PiercedElement = {
      nodeId: raw.nodeId,
      backendNodeId: raw.backendNodeId,
      tag: raw.nodeName.toLowerCase(),
      nodeName: raw.nodeName,
      attributes: attrsOf(raw),
      inClosedShadowRoot: inClosed,
      text: "",
      visibleText: "",
      ...(frameUrl ? { frameUrl } : {}),
      ...(shadowRootType ? { shadowRootType } : {}),
      inBody: inBody || raw.nodeName === "BODY",
      children: [],
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
    // 隐藏子树（script/style/...）的文字不进 visibleText：那是"页面上看不见的字"，
    // 拿它匹配会把 <body> 这种巨大祖先当成命中（页面把 "发布" 写进内联 JSON 时必然发生）
    const own = HIDDEN_TAGS.has(raw.nodeName) ? "" : rawText;
    const kids = HIDDEN_TAGS.has(raw.nodeName) ? [] : el.children.map((k) => k.visibleText).filter(Boolean);
    el.visibleText = normalizeSpace(`${own} ${kids.join(" ")}`);

    // shadow root：与 light DOM 平行的一棵子树。闭包内的 open shadow 同样算「在闭包内」。
    // 注意 Chrome 会给 <input placeholder> 之类挂 user-agent shadow root——它也在树里，
    // 类型如实标出（"user-agent"），选择器查找会跳过（见 querySelectorInTree）。
    for (const sr of raw.shadowRoots || []) {
      const srClosed = inClosed || sr.shadowRootType === "closed";
      if (sr.shadowRootType === "closed") closedShadowRoots++;
      roots.push({
        kind: "shadow-root",
        nodeId: sr.nodeId,
        backendNodeId: sr.backendNodeId,
        shadowRootType: sr.shadowRootType,
        inClosedShadowRoot: srClosed,
      });
      // shadow 变体的 XPath 不带 //body// 前缀 → 其内容一律视为「在 body 内」
      walkContainer(sr, srClosed, true, frameUrl, sr.shadowRootType);
    }
    // iframe：同进程文档才有 contentDocument；跨进程（OOPIF）此处为空 → 记入覆盖边界
    if (raw.nodeName === "IFRAME") {
      if (raw.contentDocument) {
        const cd = raw.contentDocument;
        roots.push({
          kind: "iframe-document",
          nodeId: cd.nodeId,
          backendNodeId: cd.backendNodeId,
          inClosedShadowRoot: inClosed,
          url: cd.baseURL,
          frameId: cd.frameId,
        });
        walkContainer(cd, inClosed, false, cd.baseURL);
      } else {
        // 跨进程 OOPIF / 还没加载完的子文档：本次遍历够不到它内部
        uncoveredIframes.push({
          src: el.attributes.src || "",
          ...(frameUrl ? { inFrameUrl: frameUrl } : {}),
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
    frameId: root.frameId,
  });
  walkContainer(root, false, false, root.baseURL);

  const metrics = (await send("Page.getLayoutMetrics").catch(() => null)) as {
    cssLayoutViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number };
  } | null;
  const lv = metrics?.cssLayoutViewport;
  const dprRes = (await send("Runtime.evaluate", {
    expression: "window.devicePixelRatio",
    returnByValue: true,
  }).catch(() => null)) as { result?: { value?: number } } | null;

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
    nodeCount,
  };
}

/**
 * 覆盖边界的一句话说明（结果里有未覆盖 iframe 时附上）。
 * 用词必须诚实：够不到的原因可能是跨进程，也可能只是还没加载完——不替调用方下结论。
 */
export function uncoveredIframeNote(tree: PiercedTree): string | undefined {
  if (tree.uncoveredIframes.length === 0) return undefined;
  const list = tree.uncoveredIframes.map((f) => f.src || "(no src)").join(", ");
  return `closed-shadow piercing does not cover ${tree.uncoveredIframes.length} iframe(s) whose document is not in this page's process (cross-origin frame, or not loaded yet): ${list}. Elements inside them are not reported; this is a boundary, not an empty result.`;
}

// ─────────────────────────── 查找 ───────────────────────────

export interface TextQuery {
  text: string;
  /** true = 折叠空白后整串相等（默认子串包含，与既有 click {text} 一致） */
  exact?: boolean;
}

function textMatches(value: string, q: TextQuery): boolean {
  // 与 content script 同规则：折叠口径 + 原样口径，两个都算（抄回来的原样文字要能命中）
  return q.exact
    ? normalizeSpace(value) === normalizeSpace(q.text) || value === q.text
    : textContains(value, q.text);
}

/**
 * 文本查找：镜像 content script `findByText` 的 XPath 语义
 * （`//body//button[contains(...)] | //body//a[...] | //body//input[contains(@value,...)] |
 * //body//*[not(hidden)][contains(...) and not(./*[not(hidden)][contains(...)])]`，
 * UNION 结果按文档序取第一个**可见**的）。
 * 关键在叶子规则：button/a/input 分支命中即候选；通用分支要求「没有同样命中的非隐藏子元素」。
 * 这里只算候选（按文档序），可见性由 `describeElements` 用真实盒模型判定，调用方取第一个可见的。
 *
 * **一处刻意的优待**：先按 `visibleText`（看不见的 script/style 子树不算数）匹配，一条都没有时
 * 才退回 XPath 的 `text`（含隐藏子树）。理由是兜底通道只在页面内通道全 miss 时才被调用，
 * 此时"只有隐藏文字命中"的候选（典型是页面把 "发布" 写进内联 JSON 时命中的 `<body>`）
 * 不是调用方要找的东西——把它排在前面会把真正的目标挤掉，正是「notFound 掩盖根因」的翻版。
 * 正常页面上两者一致，行为无差别。
 */
export function findByTextInTree(tree: PiercedTree, q: TextQuery): PiercedElement[] {
  const collect = (basisOf: (el: PiercedElement) => string): PiercedElement[] => {
    const hits: PiercedElement[] = [];
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

export type SelectorKind = "css" | "xpath" | "path";

/**
 * 选择器形态判定。`xpath:` / `>>>` / `#shadow-root` 这类路径式选择器**不走兜底**：
 * 它们无法寻址 closed shadow root 内的节点（闭包内拼不出稳定路径），
 * 与其给一个含糊的 notFound，不如由上层明确报「这种选择器穿不进闭包」。
 */
export function selectorKind(selector: string): SelectorKind {
  if (selector.startsWith("xpath:")) return "xpath";
  const css = selector.startsWith("css:") ? selector.slice(4) : selector;
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(" || ch === "[") { depth++; continue; }
    if (ch === ")" || ch === "]") { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (ch === ">" && css[i + 1] === ">" && css[i + 2] === ">") return "path";
    if (css.startsWith("#shadow-root", i)) return "path";
  }
  return "css";
}

/**
 * CSS 选择器查找：逐个 root（顶层文档 / shadow root / iframe 文档）调 `DOM.querySelectorAll`。
 * 这是唯一能精确命中 closed shadow root 内元素的选择器通道（见文件头事实 4）。
 * root 间按遍历序、root 内按文档序 → 结果即文档序。
 * 跳过 `user-agent` shadow root（Chrome 给 `<input placeholder>` 之类挂的内部树）：
 * 页面作者既写不出也选不中那些节点，把它们算进 matchCount 只会制造噪声。
 */
export async function querySelectorInTree(
  send: CdpSend,
  tree: PiercedTree,
  selector: string,
): Promise<{ hits: PiercedElement[]; error?: string }> {
  const css = selector.startsWith("css:") ? selector.slice(4) : selector;
  const out: PiercedElement[] = [];
  const seen = new Set<number>();
  let lastError: string | undefined;
  for (const root of tree.roots) {
    if (root.shadowRootType === "user-agent") continue;
    let res: { nodeIds?: number[] } | null = null;
    try {
      res = (await send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: css })) as { nodeIds?: number[] };
    } catch (err) {
      // 选择器语法非法（每个 root 都同样抛）或 root nodeId 已过期——记下原因，继续试其它 root
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

// ─────────────────────────── 描述 / 几何 ───────────────────────────

export interface ElementFacts {
  tag: string;
  /** class 列表前 3 个用 "." 连接（与 click 的 coveredBy.class 同口径），无 class 则省略 */
  class?: string;
  /** innerText 折叠空白后的文本：**匹配/过滤**用（判定口径与 content script 一致），不作为报告文字给用户 */
  text: string;
  /** textContent 原样：**报告给用户**的文字（hit.text / coveredBy.text / list_elements[].text 都是它）。不 trim、不折叠、不截断 */
  rawText: string;
  rectCss: { x: number; y: number; w: number; h: number } | null;
  centerCss: { x: number; y: number } | null;
  /** display/visibility 非 none/hidden 且盒模型非零（与 content script isVisible 同规则） */
  visible: boolean;
  /** 活 DOM 的 isContentEditable（`list_elements --filter editable` 用；属性上看不出继承的编辑态） */
  editable?: boolean;
  backendNodeId: number;
  inClosedShadowRoot: boolean;
  frameUrl?: string;
  // list_elements 条目需要透传的字段（命名与 ElementInfo 一致）
  role?: string;
  ariaLabel?: string;
  title?: string;
  type?: string;
  accept?: string;
  multiple?: boolean;
  name?: string;
  placeholder?: string;
}

/** 描述字段一次求值（在页面里跑，对闭包内节点同样可用） */
const FACT_FN = `function(){
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

type RawFacts = Partial<{
  tag: string; class: string; text: string; rawText: string;
  display: string | null; visibility: string | null;
  editable: boolean;
  role: string; ariaLabel: string; title: string;
  type: string; accept: string; multiple: boolean; name: string; placeholder: string;
}>;

async function factsOf(send: CdpSend, backendNodeId: number): Promise<RawFacts> {
  try {
    const resolved = (await send("DOM.resolveNode", { backendNodeId })) as { object?: { objectId?: string } };
    const objectId = resolved?.object?.objectId;
    if (!objectId) return {};
    const res = (await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: FACT_FN,
      returnByValue: true,
    })) as { result?: { value?: RawFacts } };
    return res?.result?.value || {};
  } catch {
    // 节点在两次调用之间随页面变化消失：保留树里的静态信息，几何为 null
    return {};
  }
}

/** 元素几何（border quad）。quad 是**顶层视口坐标 CSS px**，与 real_click {x,y} 同口径 */
export async function boxOf(
  send: CdpSend,
  backendNodeId: number,
): Promise<{ rectCss: { x: number; y: number; w: number; h: number }; centerCss: { x: number; y: number } } | null> {
  const rect = await quadsBbox(send, backendNodeId);
  if (!rect) return null;
  return { rectCss: rect, centerCss: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } };
}

async function quadsBbox(
  send: CdpSend,
  backendNodeId: number,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const bbox = (quads?: number[][]): { x: number; y: number; w: number; h: number } | null => {
    if (!quads || quads.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of quads) {
      for (let i = 0; i + 1 < q.length; i += 2) {
        minX = Math.min(minX, q[i]); minY = Math.min(minY, q[i + 1]);
        maxX = Math.max(maxX, q[i]); maxY = Math.max(maxY, q[i + 1]);
      }
    }
    if (!(maxX >= minX) || !(maxY >= minY)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  };
  try {
    const res = (await send("DOM.getBoxModel", { backendNodeId })) as { model?: { border?: number[] } };
    const hit = bbox(res?.model?.border ? [res.model.border] : undefined);
    if (hit) return hit;
  } catch {
    // display:none 无盒模型；行内元素多矩形时 getBoxModel 也可能失败 → 落到 getContentQuads
  }
  try {
    const res = (await send("DOM.getContentQuads", { backendNodeId })) as { quads?: number[][] };
    return bbox(res?.quads);
  } catch {
    return null;
  }
}

/**
 * 一次性取若干元素的 tag/class/text/几何/可见性。
 * 几何统一走 `DOM.getBoxModel`（顶层视口坐标）——**不要**用 in-page 的 getBoundingClientRect
 * 代替：iframe 内元素的 rect 是 frame 局部坐标，口径会不一致。
 */
export async function describeElements(send: CdpSend, items: PiercedElement[]): Promise<ElementFacts[]> {
  const out: ElementFacts[] = [];
  for (const el of items) {
    const raw = await factsOf(send, el.backendNodeId);
    const box = await boxOf(send, el.backendNodeId);
    out.push({
      tag: raw.tag || el.tag,
      ...(raw.class ? { class: raw.class } : {}),
      text: raw.text !== undefined ? raw.text : el.text,
      rawText: raw.rawText !== undefined ? raw.rawText : el.text,
      rectCss: box ? box.rectCss : null,
      centerCss: box ? box.centerCss : null,
      visible:
        !!box &&
        box.rectCss.w > 0 &&
        box.rectCss.h > 0 &&
        raw.display !== "none" &&
        raw.visibility !== "hidden",
      backendNodeId: el.backendNodeId,
      inClosedShadowRoot: el.inClosedShadowRoot,
      ...(raw.editable ? { editable: true } : {}),
      ...(el.frameUrl ? { frameUrl: el.frameUrl } : {}),
      ...(raw.role ? { role: raw.role } : {}),
      ...(raw.ariaLabel ? { ariaLabel: raw.ariaLabel } : {}),
      ...(raw.title ? { title: raw.title } : {}),
      ...(raw.type ? { type: raw.type } : {}),
      ...(raw.accept ? { accept: raw.accept } : {}),
      ...(raw.multiple ? { multiple: true } : {}),
      ...(raw.name ? { name: raw.name } : {}),
      ...(raw.placeholder ? { placeholder: raw.placeholder } : {}),
    });
  }
  return out;
}

/** 树里没有的节点（例如命中落在别的 target 上）也要能描述——造一个只带 id 的壳 */
function syntheticElement(backendNodeId: number): PiercedElement {
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
    children: [],
  };
}

/** 只描述单个 backendNodeId（get_rect / click / get_prop / get_text 的 backendNodeId 定位入口） */
export async function describeBackendNode(
  send: CdpSend,
  tree: PiercedTree,
  backendNodeId: number,
): Promise<ElementFacts | null> {
  const known = tree.byBackendId.get(backendNodeId);
  const [facts] = await describeElements(send, [known || syntheticElement(backendNodeId)]);
  return facts ?? null;
}

/**
 * `hit` 是不是 `target` 自己或它的后代（穿 shadow 边界）。
 * 判断"被遮挡"要用它：命中落在目标的子元素上（按钮里的 `<span>`）不算被盖住——
 * 与 in-page 版本 `el.contains(top)` 表达同一件事，只是必须从协议层问，因为闭包内的
 * 父子关系在页面里根本看不见。
 */
export async function isSelfOrDescendant(
  send: CdpSend,
  targetBackendNodeId: number,
  hitBackendNodeId: number,
): Promise<boolean> {
  if (targetBackendNodeId === hitBackendNodeId) return true;
  const targetObj = await resolveObjectId(send, targetBackendNodeId);
  const hitObj = await resolveObjectId(send, hitBackendNodeId);
  if (!targetObj || !hitObj) return false;
  try {
    const res = (await send("Runtime.callFunctionOn", {
      objectId: targetObj,
      functionDeclaration: "function(other){ return !!(this.contains && this.contains(other)); }",
      arguments: [{ objectId: hitObj }],
      returnByValue: true,
    })) as { result?: { value?: boolean } };
    return res?.result?.value === true;
  } catch {
    return false;
  }
}

/**
 * 命中测试：这个坐标上真正被点到的元素是谁。
 * `x`,`y` 是**顶层视口坐标**（与 real_click / get_rect.centerCss 同一口径），
 * 内部按页面坐标（+ 顶层滚动）调用 `DOM.getNodeForLocation`——协议要求页面坐标，
 * 传视口坐标会报 `No node found at given location`（实测踩过）。
 * in-page 的 elementFromPoint 在 closed shadow 上会把结果 retarget 成宿主元素，
 * 只有这条通道是真实的。
 *
 * 滚动量**此刻重取**，不用树里的快照：取树之后页面可能已经滚过（real_click 按 backendNodeId
 * 定位时会先 scrollIntoViewIfNeeded；提示条出现/消失还会改变可滚动范围，底部整页被顶/放 56px），
 * 拿旧快照换算出的页面坐标是**另一个点**——回执于是报出别的元素、或者说"那儿什么都没有"，
 * 而点击用的视口坐标本来是对的（实测踩过：点中闭包里的「发布」，回执报 .main）。
 * 重取失败就退回快照：宁可略旧，也不能因为一次量不到就把回执整个丢掉。
 */
export async function hitTestAt(
  send: CdpSend,
  tree: PiercedTree,
  x: number,
  y: number,
): Promise<(ElementFacts & { frameId?: string }) | null> {
  const fresh = (await send("Page.getLayoutMetrics").catch(() => null)) as {
    cssLayoutViewport?: { pageX?: number; pageY?: number };
  } | null;
  const lv = fresh?.cssLayoutViewport;
  const scrollX = typeof lv?.pageX === "number" ? Math.round(lv.pageX) : tree.scroll.x;
  const scrollY = typeof lv?.pageY === "number" ? Math.round(lv.pageY) : tree.scroll.y;
  const px = Math.round(x + scrollX);
  const py = Math.round(y + scrollY);
  let loc: { backendNodeId?: number; frameId?: string } | null = null;
  try {
    loc = (await send("DOM.getNodeForLocation", { x: px, y: py })) as { backendNodeId?: number; frameId?: string };
  } catch {
    return null; // 坐标在页面之外 / 该处无节点
  }
  const backendNodeId = loc?.backendNodeId;
  if (backendNodeId == null) return null;
  const known = tree.byBackendId.get(backendNodeId);
  const [facts] = await describeElements(send, [known || syntheticElement(backendNodeId)]);
  if (!facts) return null;
  return { ...facts, ...(loc?.frameId ? { frameId: loc.frameId } : {}) };
}

/** 命中/覆盖描述（与 click 的 clickDesc.coveredBy 同口径，另加闭包来源与 backendNodeId） */
export function toHitDescription(facts: ElementFacts): Record<string, unknown> {
  return {
    tag: facts.tag,
    ...(facts.class ? { class: facts.class } : {}),
    ...(facts.rawText ? { text: facts.rawText } : {}),
    backendNodeId: facts.backendNodeId,
    inClosedShadowRoot: facts.inClosedShadowRoot,
  };
}

// ─────────────────────────── 动作 ───────────────────────────

/** 滚进视口（closed shadow 内节点同样可用）；失败静默——后续点击会照常尝试 */
export async function scrollIntoView(send: CdpSend, backendNodeId: number): Promise<void> {
  await send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
}

/** 与 content script `dispatchFullClick` 同款事件序列（真实用户点击顺序，composed 穿出闭包） */
const CLICK_FN = `function(){
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

/**
 * `click {backendNodeId}`：在闭包内派发与页面内 click 完全同款的事件序列。
 * 合成事件 isTrusted=false（与既有 click 语义一致）；需要受信任点击用 `real_click {backendNodeId}`。
 * 返回的是该元素所在文档的局部坐标——只作回执，不要拿去 real_click。
 */
export async function dispatchSyntheticClick(
  send: CdpSend,
  backendNodeId: number,
): Promise<{ cx: number; cy: number } | null> {
  const objectId = await resolveObjectId(send, backendNodeId);
  if (!objectId) throw new StaleNodeError(backendNodeId); // 静默 no-op 就是「假成功」
  const res = (await send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: CLICK_FN,
    returnByValue: true,
    userGesture: true,
  })) as { result?: { value?: { cx?: number; cy?: number } } };
  const v = res?.result?.value;
  if (!v || typeof v.cx !== "number" || typeof v.cy !== "number") return null;
  return { cx: v.cx, cy: v.cy };
}

/** `get_text {backendNodeId}`：原样返回 textContent（与页面内 get_text 的零加工口径一致） */
export async function textOf(send: CdpSend, backendNodeId: number): Promise<string | null> {
  const objectId = await resolveObjectId(send, backendNodeId);
  if (!objectId) throw new StaleNodeError(backendNodeId); // 空字符串是「读到了但没文字」，不能用来表示「读不到」
  const res = (await send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function(){ return this.textContent === undefined ? null : this.textContent; }",
    returnByValue: true,
  })) as { result?: { value?: string | null } };
  const text = res?.result?.value;
  return typeof text === "string" ? text : null;
}

/**
 * `get_prop {backendNodeId}`：读取属性值。
 * 保真要求与页面内 get_prop 一致——函数 / undefined / 非普通对象不能悄悄发回去
 * （JSON 链路会把它们丢成空值，那是静默假结果）。不可序列化的值最终由 CDP `returnByValue`
 * 兜底（循环引用等直接报错），错误原样带出。
 */
export async function propertyOf(
  send: CdpSend,
  backendNodeId: number,
  prop: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
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
    const res = (await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fn,
      arguments: [{ value: prop }],
      returnByValue: true,
    })) as { result?: { value?: { err?: string; value?: unknown; tag?: string; ctor?: string } } };
    const out = res?.result?.value;
    if (!out) return { ok: false, error: `Could not read property "${prop}" from the element` };
    if (out.err === "absent") {
      return { ok: false, error: `No property "${prop}" on <${out.tag}> — examples: "innerHTML", "textContent", "value", "className", "checked", "id", "src", "href", "dataset"` };
    }
    if (out.err === "function") return { ok: false, error: `"${prop}" is a method on <${out.tag}> — get_prop only reads properties, it never calls methods` };
    if (out.err === "undefined") return { ok: false, error: `Property "${prop}" on <${out.tag}> is undefined (element found, but the property has no value)` };
    if (out.err === "nonplain") {
      return { ok: false, error: `Property "${prop}" on <${out.tag}> holds a ${out.ctor || "non-plain"} object — only plain data can be returned; read a string/number property like "innerHTML" or "value" instead` };
    }
    return { ok: true, value: out.value };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Property "${prop}" could not be serialized: ${detail}` };
  }
}

/**
 * 等「附加态视口」安定。
 *
 * 为什么必须有这一步（实测）：`chrome.debugger.attach` 会让 Chrome 浮出
 * 「扩展正在调试此浏览器」信息条，它**占据页面顶部的一条**——页面的布局视口随之
 * 从无 debugger 时的高变矮，且是渐进动画。实测 1440×749 的页面，attach 后连续测量同一
 * 固定页脚按钮（`bottom:16px`，y = 视口高 − 48）得到 701 → 674 → 645 → 645：
 * 前三次数值不同不是页面在动，是**信息条还在动画中**，稳定值 693 = 749 − 56。
 *
 * 后果（这就是必须有这一步的原因）：动画期间测出来的矩形和稍后派发出去的点击**不在
 * 同一个坐标空间**。实测症状：`get_rect {"text":"暂存离开"}` 给出 centerCss.y=717，
 * 紧接着 `real_click {"x":1272,"y":717}` 回 `hitUnavailable: nothing at that point`
 * 且按钮没收到点击——因为派发时视口已稳定到 693，按钮已上移到 645..677，717 落在页脚空白处。
 * 测量的那一刻与动作的那一刻视口不同，坐标就是错的，而且错得看不出来
 * （成功返回、无报错、按钮不动）。
 *
 * 因此：**每次 attach 之后、任何测量或派发之前**先调这里，等到连续两次读数一致。
 * 这样「量到的」与「点到的是」同一个视口，调用方拿到的坐标才是可用的真值。
 *
 * 但「等连续两次读数一致」本身还不够（实测踩到）：信息条的**出现**是滞后的，且在
 * **一个 Chrome 会话的第一次 attach** 上最明显——本次实测，重启 Chrome 后第一条
 * `get_rect`（CDP 通道）在 attach 后 ~0.4s 量到 749（信息条还没冒出来），紧接着的
 * `screenshot` 量到 693。两次读数各自都"稳定"，却是两个不同的视口：调用方拿 749 空间
 * 的 y=717 去 `real_click`，派发时视口已是 693，按钮上移到 645..677，717 落在页脚空白处
 * —— 又回到上面那个「成功返回、按钮不动」的症状，只是触发条件换成了"会话里第一条命令"。
 *
 * 所以调用方可以给一个**对照高度** `inPageViewportH`（页面内通道量到的、没有 debugger 时
 * 的视口高）。给了之后就多一条判据：**没看到视口变矮就不算安定**——继续等，直到
 * `h < inPageViewportH`（信息条确认出现）再要求连续读数一致，或等到 `maxMs` 放弃。
 * 拿到对照高度的代价与时机由调用方负责（见 service-worker 的 settleAttachedViewport）。
 */
export type ViewportWait = {
  viewportCss: { w: number; h: number };
  /** true = 在 maxMs 内拿到了判据要求的状态（含「信息条已确认出现」这一条） */
  settled: boolean;
  waitedMs: number;
  readings: number;
  /** 给了对照高度时：是否真的观察到视口变矮（= 信息条出现）。没给对照高度时为 undefined */
  sawInfobar?: boolean;
};

export async function waitViewportStable(
  send: CdpSend,
  opts: { intervalMs?: number; settleMs?: number; maxMs?: number; inPageViewportH?: number | null } = {},
): Promise<ViewportWait> {
  const intervalMs = opts.intervalMs ?? 120;
  const settleMs = opts.settleMs ?? 300;
  const baseline = typeof opts.inPageViewportH === "number" ? opts.inPageViewportH : null;
  // 等信息条出现要多留时间（实测 ~1s 内出现，给到 2.5s）；只等安定则不需要那么久
  const maxMs = opts.maxMs ?? (baseline !== null ? 2500 : 1200);
  const started = Date.now();
  let prev: { w: number; h: number } | null = null;
  let readings = 0;
  let stableSince = 0;
  let sawInfobar = false;
  let last: { w: number; h: number } = { w: 0, h: 0 };
  for (;;) {
    const m = (await send("Page.getLayoutMetrics").catch(() => null)) as {
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    } | null;
    const lv = m?.cssLayoutViewport;
    last = { w: Math.round(lv?.clientWidth ?? 0), h: Math.round(lv?.clientHeight ?? 0) };
    readings++;
    if (baseline !== null && last.h > 0 && last.h < baseline) sawInfobar = true;
    // 还没确认信息条出现：这一条判据没过，读数再稳也不算安定（否则会量在"没有信息条"的空间里）
    const waitingForInfobar = baseline !== null && !sawInfobar;
    if (prev && prev.w === last.w && prev.h === last.h) {
      if (!stableSince) stableSince = Date.now();
      if (!waitingForInfobar && Date.now() - stableSince >= settleMs) {
        return {
          viewportCss: last,
          settled: true,
          waitedMs: Date.now() - started,
          readings,
          ...(baseline !== null ? { sawInfobar } : {}),
        };
      }
    } else {
      stableSince = 0;
    }
    if (Date.now() - started >= maxMs) {
      // 到上限仍没拿到判据要求的状态：如实带出 settled:false（调用方据此决定要不要信这份几何）
      return {
        viewportCss: last,
        settled: false,
        waitedMs: Date.now() - started,
        readings,
        ...(baseline !== null ? { sawInfobar } : {}),
      };
    }
    prev = last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 页面视口真值（get_viewport 的 CDP 侧；正常路径走 content script，不开 debugger） */
export async function viewportFacts(send: CdpSend): Promise<{
  viewportCss: { w: number; h: number };
  scrollCss: { x: number; y: number };
  dpr: number;
}> {
  const metrics = (await send("Page.getLayoutMetrics")) as {
    cssLayoutViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number };
  };
  const lv = metrics?.cssLayoutViewport;
  const dprRes = (await send("Runtime.evaluate", {
    expression: "window.devicePixelRatio",
    returnByValue: true,
  })) as { result?: { value?: number } };
  return {
    viewportCss: { w: Math.round(lv?.clientWidth ?? 0), h: Math.round(lv?.clientHeight ?? 0) },
    scrollCss: { x: Math.round(lv?.pageX ?? 0), y: Math.round(lv?.pageY ?? 0) },
    dpr: typeof dprRes?.result?.value === "number" ? dprRes.result.value : 1,
  };
}

// ────────────────────── list_elements {closed:true} ──────────────────────

export interface ListFilter {
  /** filter token（与 content script 同集合、同语义） */
  filters?: string[];
  text?: string;
  /** true = 只要可见的；false = 只要隐藏的 */
  visibleOnly?: boolean;
  hiddenOnly?: boolean;
}

/**
 * 只收集 **closed shadow root 内**的交互元素（`list_elements {closed:true}` 用）。
 * 只取闭包内的：其余子树页面内通道本来就能枚举，重复列出只会让调用方分不清两份来源。
 * 候选与 filter 规则与 content script 逐条对齐（`INTERACTIVE_SELECTOR` + `INTERACTIVE_ROLES`
 * + `isVisible` + filter 分支），保证同一元素两条通道判定一致。
 * 条目**没有 selector**（闭包内拼不出稳定选择器）——调用方用 backendNodeId 定位。
 */
export async function listClosedInteractive(
  send: CdpSend,
  tree: PiercedTree,
  filter: ListFilter = {},
): Promise<Record<string, unknown>[]> {
  const candidates = tree.elements.filter((el) => {
    if (!el.inClosedShadowRoot) return false;
    if (el.shadowRootType === "user-agent") return false; // 浏览器内部实现细节，不是页面元素
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
  const out: Record<string, unknown>[] = [];
  for (const f of facts) {
    if (filter.visibleOnly && !f.visible) continue;
    if (filter.hiddenOnly && f.visible) continue;
    // 文本过滤零加工：查询串不 trim，匹配按「原样 或 折叠空白后」取并集
    // （与 content script list_elements 同规则：抄回来的原样文字也要能命中）
    if (!textContains(f.rawText, textFilter)) continue;
    if (filters.length > 0) {
      const hit = filters.some((name) => {
        switch (name) {
          case "button": return f.tag === "button" || f.role === "button";
          case "link": return f.tag === "a" || f.role === "link";
          case "input": return f.tag === "input";
          case "select": return f.tag === "select";
          case "textarea": return f.tag === "textarea";
          case "label": return f.tag === "label";
          // 与 content script 的 `html.isContentEditable || …` 对齐：editable 这个事实
          // 必须从活 DOM 取（继承的 contenteditable / designMode 在属性上看不出来）
          case "editable": return !!f.editable || f.tag === "textarea" || (f.tag === "input" && !!f.type && /text|search|email|url|tel|number|password|date|time|datetime-local|month|week/.test(f.type));
          case "upload": return (f.tag === "input" && f.type === "file") || /点击上传|上传|拖入|拖拽|拖到|upload|drop/i.test(f.text);
          default: return true;
        }
      });
      if (!hit) continue;
    }
    const r = f.rectCss;
    const item: Record<string, unknown> = {
      tag: f.tag,
      visible: f.visible,
      // 坐标 = 顶层视口 CSS px（与 real_click / get_rect.centerCss 同口径）
      x: r ? Math.round(r.x) : 0,
      y: r ? Math.round(r.y) : 0,
      w: r ? Math.round(r.w) : 0,
      h: r ? Math.round(r.h) : 0,
      backendNodeId: f.backendNodeId,
      inClosedShadowRoot: true,
    };
    if (f.role) item.role = f.role;
    if (f.ariaLabel) item.ariaLabel = f.ariaLabel;
    if (f.title) item.title = f.title;
    if (f.type) item.type = f.type;
    if (f.accept) item.accept = f.accept;
    if (f.multiple) item.multiple = true;
    if (f.name) item.name = f.name;
    if (f.placeholder) item.placeholder = f.placeholder;
    // 与内容脚本 list_elements 同口径：报告文字 = 元素里的文字原样
    if (f.rawText) item.text = f.rawText;
    out.push(item);
  }
  return out;
}
