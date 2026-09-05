// 调试模式（v0.19.0）：⌘+]/Ctrl+] 唤出右侧调试浮层 + 元素选择 + 坐标预览 + 单页动作执行。
// 注入方式：与 content-script.js 同一 content_scripts 项（同隔离世界、同文档、document_idle），
// manifest 的 js 数组把本文件排在 content-script.js 之后 → window.__cdaDebug 桥必然已就位。
//
// 为什么逐帧工作：iframe 内容上的指针事件只在子 frame 自己的文档里派发，不冒泡到顶层
// （frame 边界隔离事件派发）。所以「悬停高亮 / 坐标预览 / 点击选中 / 页面点击拦截」必须在
// 每个 frame 自己的实例里做，覆盖层画在本 frame 文档中（视觉位置天然正确）：
//   - 顶层 frame：面板（仅顶层有）+ 本帧选择器 + 会话状态机（picking/idle/closed 广播）。
//   - 非顶层 frame：只跑本帧选择器。与顶层是否同源由主世界 frame-chain oracle 探测
//     （main-world.ts 的 __cda_debug_geo__）：跨域链不可达 → 本帧不启动选择器（产品范围：
//     跨域 iframe 内容不支持）。
// 事件拦截按帧执行：每帧「吞页面事件」由本帧主世界 guard（main-world.ts）执行，拦截状态
// 由本文件会话对象下发（顶层 DebugController / 非顶层 ChildSession 持帧），子帧 picker 在
// attach 时才开拦、detach 回 idle 语义。主世界拦停后把事件中继回本帧（PICK_EVT / ESC_EVT，
// 见下 ⚠ 事件模型）驱动选择与取消；面板宿主路径事件主世界一律放行（面板交互走原生事件）。
// 跨域 frame 拦不到也不拦（用户已确认跨域内容可以不支持）。
// 跨帧通道：本文件只依赖 chrome.runtime 消息（content script ↔ service worker，天然跨 frame）；
// 跨世界通道：隔离世界 → 主世界走「CustomEvent + postMessage」双投递（主世界 → 隔离世界为
// 仓库已验证的 CustomEvent 中继方向），detail 仅纯数据（跨世界结构化克隆，DOM 节点过不去）。
// ⚠ 事件模型（v0.19.0 实证修正）：主世界 guard 拦停事件时，隔离世界**收不到**同一物理事件
// （点选 click / Esc 原本全被掐死）。因此选择期事件由主世界「拦停 + 新派发中继」（PICK_EVT/
// ESC_EVT）送达本世界；面板宿主（data-cda-debug-host）路径事件主世界一律不拦，面板交互走
// 原生事件。两套入口都收、幂等去重（finishPick/closePanel 状态机天然只生效一次）。
// 选择结果聚合：非顶层选中的元素经 SW 上报顶层面板，面板展示；后续动作执行带
// 「顶层→目标」逐跳 iframe 序号链（chain），SW 逐跳解析回目标 frame 执行既有 execute_command。
// 坐标口径：面板显示与真实点击一律用「顶层视口坐标」——本帧元素局部坐标 + oracle 偏移换算。
//
// 实现整体收在一个 IIFE 内：本文件以普通脚本注入隔离世界，与 content-script.js 共享同一
// 隔离世界全局作用域，且顶层 `interface Selection` 会与 lib.dom 的全局 Selection 合并——
// 收进函数作用域后一切标识符局部化，不互相干扰也不污染全局。

(() => {
// —— 只读常量与基础类型 ——
const IS_TOP = (() => {
  try {
    return window.top === window;
  } catch {
    return true;
  }
})();

const TOGGLE_EVT = "__cda_debug_toggle__";
const INTERCEPT_EVT = "__cda_debug_intercept__";
const GEO_EVT = "__cda_debug_geo__";
const GEO_REPLY_EVT = "__cda_debug_geo_reply__";
// 主世界拦停选择期页面事件后中继的点选 / Esc（main-world.ts PICK_EVT/ESC_EVT 同名对齐）
const PICK_EVT = "__cda_debug_pick__";
const ESC_EVT = "__cda_debug_esc__";

interface BridgeResult {
  success: boolean;
  data?: unknown;
  error?: string;
  notFound?: boolean;
}
interface CdaBridge {
  handleCommand(payload: { command: string; params?: Record<string, unknown> }): Promise<BridgeResult>;
  genSelector(el: Element, rootDoc?: Document): string;
}
interface ChainHop {
  index: number;
  url: string;
}
interface GeoOk {
  ok: true;
  chain: ChainHop[];
  ox: number;
  oy: number;
}
interface GeoFail {
  ok: false;
  crossOrigin: boolean;
}
type GeoResult = GeoOk | GeoFail;

interface Selection {
  selector: string;
  tag: string; // tagName 小写
  type: string; // input 的 type 属性（非 input 为 ""）
  editable: boolean;
  chain: ChainHop[]; // 顶层→目标 逐跳；顶层元素为空数组
  clickX: number; // 选中那一刻的顶层视口坐标
  clickY: number;
  sourceFrameId: number; // 选中所在 frame（顶层 0；SW 转发时补充）
}

function getBridge(): CdaBridge | null {
  const b = (window as unknown as { __cdaDebug?: CdaBridge }).__cdaDebug;
  return b && typeof b.handleCommand === "function" && typeof b.genSelector === "function" ? b : null;
}

// —— 通用小工具 ——
const PANEL_W = 320; // 面板宽度（顶层右侧悬浮层；选择期可整体让到左侧，见 setPanelSide）
const DODGE_HYST = 60; // 浮层左右切换的滞回带（px）：光标在右缘附近小范围移动不反复横跳
const MAX_RESULT_CHARS = 4000;

function stringifyData(d: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(d, null, 1);
  } catch {
    s = String(d);
  }
  if (s == null) s = "undefined";
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `\n…（截断，共 ${s.length} 字符）` : s;
}

function fmtTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function hitsDebugHost(path: EventTarget[]): boolean {
  return path.some((n) => n instanceof Element && n.getAttribute?.("data-cda-debug-host") != null);
}

function isEditableEl(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    return /^(text|search|url|tel|email|password|number|date|time|datetime-local|month|week)$/.test(t);
  }
  return (el as HTMLElement).isContentEditable === true;
}

// —— 覆盖层（每帧一组）：悬停框 / 光标坐标片 / 选中框，画在本 frame 文档 ——
// 宿主 fixed 0,0 零尺寸 + 子元素 absolute（溢出可视），全部 pointer-events:none，
// 不遮挡也不参与页面事件命中。内容样式写死在 shadow 里，页面 CSS 影响不到。
interface Overlay {
  host: HTMLDivElement;
  root: ShadowRoot;
  hover: HTMLDivElement;
  chip: HTMLDivElement;
  sel: HTMLDivElement;
}

const OVERLAY_CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.cda-hover {
  position: absolute; pointer-events: none; display: none;
  border: 2px dashed #ff9800; border-radius: 2px; z-index: 1;
}
.cda-sel {
  position: absolute; pointer-events: none; display: none;
  border: 2px solid #1a73e8; border-radius: 2px; z-index: 2;
  background: rgba(26, 115, 232, 0.07); box-shadow: 0 0 0 1px rgba(255,255,255,.6);
}
.cda-chip {
  position: absolute; pointer-events: none; display: none; z-index: 3;
  background: rgba(32, 33, 36, 0.88); color: #fff;
  font: 11px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  padding: 2px 7px; border-radius: 9px; white-space: nowrap;
  letter-spacing: 0.3px;
}
`;

function makeOverlay(): Overlay | null {
  if (!document.documentElement) return null;
  const host = document.createElement("div");
  // all:initial 后再给定位/层级：确保不被页面任何样式规则影响
  host.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = OVERLAY_CSS;
  root.appendChild(style);
  const hover = document.createElement("div");
  hover.className = "cda-hover";
  const chip = document.createElement("div");
  chip.className = "cda-chip";
  const sel = document.createElement("div");
  sel.className = "cda-sel";
  root.appendChild(hover);
  root.appendChild(chip);
  root.appendChild(sel);
  (document.body || document.documentElement).appendChild(host);
  return { host, root, hover, chip, sel };
}

// —— frame-chain / 视口偏移 oracle 客户端（仅非顶层使用）——
// 与 main-world.ts 的 __cda_debug_geo__ 监听器往返；回复可能在独立任务到达，
// 一律以 Promise + 缓存处理，不依赖同步性。250ms 无应答（oracle 双通道皆未送达/
// 主世界异常）按失败处理——选择器不可用比永久挂起的选择会话更好。
class GeoClient {
  private seq = 0;
  private pending = new Map<number, (r: GeoResult) => void>();
  cache: GeoResult | null = null; // 最近一次成功/失败结果
  private lastAt = 0;
  private readonly TIMEOUT_MS = 250;

  constructor() {
    const onReply = (detail: unknown): void => {
      const d = detail as { requestId?: number } & Record<string, unknown>;
      if (typeof d?.requestId !== "number") return;
      const resolve = this.pending.get(d.requestId);
      if (!resolve) return;
      this.pending.delete(d.requestId);
      const result: GeoResult =
        d.ok === true
          ? { ok: true as const, chain: d.chain as ChainHop[], ox: d.ox as number, oy: d.oy as number }
          : { ok: false as const, crossOrigin: d.crossOrigin === true };
      this.cache = result;
      resolve(result);
    };
    // 主世界双通道回复（CustomEvent + postMessage）：第一份消费掉 pending，重复份被丢弃
    document.addEventListener(GEO_REPLY_EVT, (ev: Event) => onReply((ev as CustomEvent).detail));
    window.addEventListener("message", (ev: MessageEvent) => {
      const m = ev.data as { __cdaMain?: string; detail?: unknown } | undefined;
      if (m && typeof m === "object" && m.__cdaMain === GEO_REPLY_EVT) onReply(m.detail);
    });
  }

  probe(): Promise<GeoResult> {
    const requestId = ++this.seq;
    const result = new Promise<GeoResult>((resolve) => {
      this.pending.set(requestId, resolve);
      dispatchMain(GEO_EVT, { requestId, kind: "frame_chain" });
      window.setTimeout(() => {
        const pendingResolve = this.pending.get(requestId);
        if (!pendingResolve) return;
        this.pending.delete(requestId);
        this.cache = { ok: false, crossOrigin: false };
        pendingResolve({ ok: false, crossOrigin: false });
      }, this.TIMEOUT_MS);
    });
    this.lastAt = Date.now();
    return result;
  }

  // 节流探测并缓存；返回当前缓存（可能为 null：尚未探测成功）
  refreshThrottled(): void {
    if (Date.now() - this.lastAt < 150) return;
    this.probe().catch(() => {});
  }
}

// —— 跨世界下发（隔离世界 → 主世界）——
// 仓库已验证的跨世界通道是「主世界派发 CustomEvent → 隔离世界收」（错误中继）；反向
// （隔离世界派发 → 主世界收）依赖各世界共享 DOM 的派发机制，无仓库先例可依，故双通道投递：
// CustomEvent + window.postMessage（postMessage 必然跨世界可达，页面即主世界）。
// 两个入口主世界都会处理，但处理幂等（intercept 覆盖写）/回复重复无害（pending 按
// requestId 只消费一次），不存在重复触发问题。
function dispatchMain(type: string, detail: unknown): void {
  try {
    document.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {
    // 页面劫持 dispatchEvent 等极端情况：忽略
  }
  try {
    window.postMessage({ __cdaMain: type, detail }, "*");
  } catch {
    // 忽略：postMessage 不可用时 CustomEvent 通道兜底
  }
}

// —— 主世界拦截状态下发 ——
function setIntercept(picking: boolean, iso: boolean): void {
  dispatchMain(INTERCEPT_EVT, { picking, iso });
}

// —— 本帧元素选择器 ——
type SelectCb = (sel: Selection, el: Element) => void;

class FramePicker {
  private overlay: Overlay | null = null;
  private active = false;
  private attached = false; // overlay DOM 与事件监听各自独立：会话间复用 DOM，进出 picking 只增删监听
  private chain: ChainHop[] = [];
  private offset = { ox: 0, oy: 0 };
  private offsetReady = false; // 非顶层探测成功前不画坐标片（避免局部坐标冒充顶层坐标）
  private geo = new GeoClient();
  private hoverEl: Element | null = null;
  private ringTarget: Element | null = null; // 选中后需要保持的框
  private ringTimer = 0;
  private onSelectCb: SelectCb | null = null;
  private onEscCb: ((reason: "esc" | "fail") => void) | null = null;

  private readonly onMove = (ev: Event) => this.handleMove(ev as MouseEvent);
  private readonly onClick = (ev: Event) => this.handleClick(ev as MouseEvent);
  private readonly onOut = (ev: Event) => this.handleOut(ev as MouseEvent);
  private readonly onKey = (ev: Event) => this.handleKey(ev as KeyboardEvent);
  private readonly onPickRelay = (ev: Event) => this.handlePickRelay(ev as CustomEvent);
  private readonly onEscRelay = (_ev: Event) => this.abortPick("esc");
  private readonly onScroll = () => this.repositionAll();
  private readonly onResize = () => this.repositionAll();

  constructor(private readonly forTop: boolean) {
    // 顶层初始偏移为 0 无需探测；子 frame 的探测结果直接驱动是否可启动选择器
  }

  // —— 会话生命周期（由 debug_mode 广播驱动，幂等）——
  startPicking(onSelect: SelectCb, onEsc: (reason: "esc" | "fail") => void): void {
    if (this.active) return;
    this.onSelectCb = onSelect;
    this.onEscCb = onEsc;
    this.active = true;
    this.clearRing(); // 新会话：旧的选中框/悬停全部清掉
    this.hideChip();
    if (this.forTop) {
      this.chain = [];
      this.offset = { ox: 0, oy: 0 };
      this.offsetReady = true;
      this.attach();
      return;
    }
    // 非顶层：先探测同源可达性 + 偏移，再决定是否真的可选取
    this.offsetReady = false;
    this.geo
      .probe()
      .then((r) => {
        if (!this.active) return; // 探测期间会话已结束
        if (!r.ok) {
          // 跨域边界：本帧不可选。事件按帧独立派发、顶层拦不到本帧页面，跨域内容
          // 不受保护是已接受的边界（用户确认「跨域的可以不支持」）；本帧也不开拦截
          this.clearCallbacks();
          this.active = false;
          return;
        }
        this.chain = r.chain;
        this.offset = { ox: r.ox, oy: r.oy };
        this.offsetReady = true;
        this.attach();
      })
      .catch(() => {
        this.clearCallbacks();
        this.active = false;
      });
  }

  stopPicking(): void {
    if (!this.active) return;
    this.active = false;
    this.detach();
    this.hoverEl = null;
    this.hideChip();
    if (this.overlay) this.overlay.hover.style.display = "none";
  }

  // 会话结束（面板关闭）：选择器与所有框全清。悬停框/坐标片必须同 stopPicking 一并收掉：
  // 直接关闭浮层（Esc/×）的路径不经过 stopPicking，漏收会把最后悬停元素的高亮残影
  // 留在页面上
  dispose(): void {
    this.active = false;
    this.detach();
    this.clearCallbacks();
    this.hoverEl = null;
    this.hideChip();
    if (this.overlay) this.overlay.hover.style.display = "none";
    this.clearRing();
  }

  private clearCallbacks(): void {
    this.onSelectCb = null;
    this.onEscCb = null;
  }

  private attach(): void {
    if (this.attached) return;
    if (!this.overlay) this.overlay = makeOverlay();
    if (!this.overlay) return;
    this.attached = true;
    // 非顶层：attach 成功才开本帧拦截——事件不跨 frame 边界，子 frame 内的点击只能靠
    // 本帧主世界拦（iso=false：子帧没有面板；回 idle 的 Esc 归浮层由 detach 补置）。
    // 顶层拦截（picking+iso）由顶层会话对象统一管理，这里不重复置位。
    if (!this.forTop) setIntercept(true, false);
    // 主世界中继入口：选择期页面区 click / Esc 被主世界拦停后新派发到本帧文档（原生物理
    // 事件的隔离世界派发已被 stop 掐掉，见文件头 ⚠ 事件模型），PICK_EVT / ESC_EVT 是
    // 点选与取消的主路径；原生 click/keydown 监听保留作主世界缺席时的兜底（模型 Y）。
    // 两路都到也只会生效一次：finishPick/abortPick 后 active=false，后到者被忽略。
    document.addEventListener(PICK_EVT, this.onPickRelay);
    document.addEventListener(ESC_EVT, this.onEscRelay);
    window.addEventListener("mousemove", this.onMove, true);
    window.addEventListener("click", this.onClick, true);
    window.addEventListener("mouseout", this.onOut, true);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("scroll", this.onScroll, true);
    window.addEventListener("resize", this.onResize);
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    // 非顶层：回 idle 语义——页面点击还原，Esc 继续归浮层（iso=true：焦点在本帧内时
    // Esc 中继仍可达，由会话对象兜底上报顶层）；面板彻底关闭的清场由会话 dispose 补
    if (!this.forTop) setIntercept(false, true);
    document.removeEventListener(PICK_EVT, this.onPickRelay);
    document.removeEventListener(ESC_EVT, this.onEscRelay);
    window.removeEventListener("mousemove", this.onMove, true);
    window.removeEventListener("click", this.onClick, true);
    window.removeEventListener("mouseout", this.onOut, true);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("resize", this.onResize);
  }

  // —— 事件处理（只处理本 frame 文档内的事件：子 frame 内容事件到不了这里）——
  private handleMove(ev: MouseEvent): void {
    if (!this.active || !this.overlay) return;
    if (!this.offsetReady) {
      this.geo.refreshThrottled();
      return;
    }
    // 刷新偏移（子 frame 时父级滚动会改变换算值）
    if (!this.forTop) this.geo.refreshThrottled();
    const path = ev.composedPath();
    if (hitsDebugHost(path)) {
      this.hoverEl = null;
      this.overlay.hover.style.display = "none";
      this.hideChip();
      return;
    }
    const el = deepestElement(path);
    if (!el || el === document.documentElement) {
      this.hoverEl = null;
      this.overlay.hover.style.display = "none";
      this.hideChip();
      return;
    }
    this.hoverEl = el;
    this.placeRing(this.overlay.hover, el);
    // 坐标片：内容 = 顶层视口坐标，位置 = 本帧局部坐标（视觉上贴着鼠标）
    const tx = Math.round(ev.clientX + this.offset.ox);
    const ty = Math.round(ev.clientY + this.offset.oy);
    this.showChip(ev.clientX, ev.clientY, `(${tx}, ${ty})`);
  }

  private handleOut(ev: MouseEvent): void {
    if (!this.active) return;
    // 指针离开本 frame 文档（进入 iframe 内容 / 离开页面）：相关目标跨文档或为空
    const rt = ev.relatedTarget;
    if (rt === null || (rt instanceof Node && rt.ownerDocument !== document)) {
      this.hoverEl = null;
      if (this.overlay) this.overlay.hover.style.display = "none";
      this.hideChip();
    }
  }

  // 原生 click（兜底路径）：主世界缺席时（未注入/已损坏）原生物理事件仍能到达本世界。
  // 正常模型下选择期页面区点击已被主世界吞掉，这里收不到；宿主路径点击则按面板交互跳过。
  private handleClick(ev: MouseEvent): void {
    if (!this.active || !this.overlay) return;
    if (ev.button !== 0) return;
    const path = ev.composedPath();
    if (hitsDebugHost(path)) return; // 面板自身交互不算点选
    ev.stopPropagation(); // 本世界内停掉后续监听
    this.pickAt(deepestElement(path), ev.clientX, ev.clientY);
  }

  // 主世界中继的点击（主路径）：detail 是纯坐标——跨世界结构化克隆带不了 DOM 节点。
  // 主世界拦停 click 前一刻鼠标必然悬停在被点元素上（点击前没有 mousemove）→ hoverEl
  // 优先；元素已失联/坐标对不上（布局变了）→ elementFromPoint 兜底（全部覆盖层
  // pointer-events:none，不会命中到自身）。
  private handlePickRelay(ev: CustomEvent): void {
    if (!this.active || !this.overlay) return;
    const d = ev.detail as { x?: number; y?: number } | undefined;
    if (!d || typeof d.x !== "number" || typeof d.y !== "number") return;
    let el = this.hoverEl;
    if (el && el.isConnected) {
      const r = el.getBoundingClientRect();
      if (d.x < r.left - 1 || d.x > r.right + 1 || d.y < r.top - 1 || d.y > r.bottom + 1) el = null;
    } else {
      el = null;
    }
    if (!el) {
      try {
        el = document.elementFromPoint(d.x, d.y);
      } catch {
        el = null;
      }
    }
    this.pickAt(el, d.x, d.y);
  }

  // 点选统一收尾（中继与原生兜底两路都汇到这里；x/y = 本帧口径的点击点）
  private pickAt(el: Element | null, x: number, y: number): void {
    if (!this.active || !this.overlay) return;
    if (!el || el === document.documentElement) return;

    // 非顶层：点选瞬间重新探测一次，取最新 chain/偏移（父级滚动/iframe 重排后仍准确）
    const finalize = (chain: ChainHop[], ox: number, oy: number) => {
      if (!this.active) return;
      const sel: Selection = {
        selector: "",
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute("type") || "").toLowerCase(),
        editable: isEditableEl(el),
        chain,
        clickX: Math.round(x + ox),
        clickY: Math.round(y + oy),
        sourceFrameId: 0,
      };
      const bridge = getBridge();
      if (!bridge) {
        this.abortPick("fail");
        return;
      }
      sel.selector = bridge.genSelector(el, el.ownerDocument);
      this.finishPick(sel, el);
    };

    if (this.forTop) {
      finalize([], 0, 0);
    } else {
      this.geo
        .probe()
        .then((r) => {
          if (!this.active) return;
          if (!r.ok) {
            this.abortPick("fail");
            return;
          }
          finalize(r.chain, r.ox, r.oy);
        })
        .catch(() => this.abortPick("fail"));
    }
  }

  // 原生 Esc（兜底路径，见 handleClick 注释；正常模型的 Esc 走主世界中继）
  private handleKey(ev: KeyboardEvent): void {
    if (!this.active) return;
    if (ev.key === "Escape") {
      ev.stopPropagation();
      this.abortPick("esc");
    }
  }

  // 点选收尾：停监听、保留选中框、回调（顶层：面板；子 frame：SW 上报）
  private finishPick(sel: Selection, el: Element): void {
    const cb = this.onSelectCb;
    this.clearCallbacks();
    this.stopPicking();
    this.adoptRing(el);
    cb?.(sel, el);
  }

  // 取消选择：reason=esc（用户 Esc，顶层语义 = 关闭浮层）；fail（桥缺失 / 跨域探测失败，
  // 顶层语义 = 退出选择会话但面板保留提示）。通知上层并停掉本帧选择状态
  private abortPick(reason: "esc" | "fail"): void {
    const esc = this.onEscCb;
    this.clearCallbacks();
    this.stopPicking();
    esc?.(reason);
  }

  // —— 选中框（ring）保持：选中后由本帧持续跟随元素，直到新会话/面板关闭 ——
  private adoptRing(el: Element): void {
    if (!this.overlay) return;
    this.ringTarget = el;
    this.placeRing(this.overlay.sel, el);
    this.overlay.sel.style.display = "block";
    if (this.ringTimer) return;
    this.ringTimer = window.setInterval(() => {
      const t = this.ringTarget;
      if (!this.overlay || !t) {
        if (this.overlay) this.overlay.sel.style.display = "none";
        window.clearInterval(this.ringTimer);
        this.ringTimer = 0;
        this.ringTarget = null;
        return;
      }
      // 元素已被页面移除：框消失（面板动作执行时会以 notFound 如实报错）
      if (!t.isConnected) {
        this.overlay.sel.style.display = "none";
        window.clearInterval(this.ringTimer);
        this.ringTimer = 0;
        this.ringTarget = null;
        return;
      }
      this.placeRing(this.overlay.sel, t);
    }, 300);
  }

  private clearRing(): void {
    this.ringTarget = null;
    if (this.ringTimer) {
      window.clearInterval(this.ringTimer);
      this.ringTimer = 0;
    }
    if (this.overlay) this.overlay.sel.style.display = "none";
  }

  private placeRing(ring: HTMLDivElement, el: Element): void {
    const r = el.getBoundingClientRect();
    const pad = 2;
    ring.style.left = `${r.left - pad}px`;
    ring.style.top = `${r.top - pad}px`;
    ring.style.width = `${r.width + pad * 2}px`;
    ring.style.height = `${r.height + pad * 2}px`;
    ring.style.display = "block";
  }

  private repositionAll(): void {
    if (!this.overlay) return;
    if (this.active && this.hoverEl && this.hoverEl.isConnected) {
      this.placeRing(this.overlay.hover, this.hoverEl);
    }
    if (this.ringTarget && this.ringTarget.isConnected) {
      this.placeRing(this.overlay.sel, this.ringTarget);
    }
    if (this.active && !this.forTop) this.geo.refreshThrottled();
  }

  private showChip(clientX: number, clientY: number, label: string): void {
    const chip = this.overlay!.chip;
    chip.textContent = label;
    const pad = 10;
    const w = chip.offsetWidth;
    const h = chip.offsetHeight;
    let left = clientX + 14;
    let top = clientY + 20;
    // 顶层右侧有面板占位：坐标片不被面板盖住，右边界按「面板左缘」收缩
    const vw = window.innerWidth - (this.forTop ? PANEL_W + pad : 0);
    const vh = window.innerHeight;
    if (left + w + pad > vw) left = Math.max(pad, clientX - w - 12);
    if (top + h + pad > vh) top = Math.max(pad, clientY - h - 8);
    chip.style.left = `${left}px`;
    chip.style.top = `${top}px`;
    chip.style.display = "block";
  }

  private hideChip(): void {
    if (this.overlay) this.overlay.chip.style.display = "none";
  }
}

function deepestElement(path: EventTarget[]): Element | null {
  for (const n of path) {
    if (n instanceof Element) return n;
  }
  return null;
}

// ============================ 顶层：面板与会话控制 ============================
// 会话状态机：面板开=自动进选择模式；点选成功/取消 → idle；关闭 → closed 广播清场。
// 状态经 SW 广播到所有 frame：各 frame 的选择器按状态启停（顶层本地直接驱动，广播回声幂等）。

const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; }
.panel {
  position: fixed; top: 0; right: 0; bottom: 0; width: ${PANEL_W}px; z-index: 2147483647;
  display: flex; flex-direction: column; background: #fff; color: #202124;
  border-left: 1px solid #dadce0; box-shadow: -4px 0 16px rgba(0, 0, 0, 0.12);
  font-size: 13px; line-height: 1.5;
  /* 宿主是 pointer-events:none（不挡 hit-test），面板本体必须重新可命中：
     auto 沿子树继承，面板区整体拦截点击（页面收不到面板区域下的点击） */
  pointer-events: auto;
}
.panel.side-left {
  /* 躲鼠标：picking 期光标逼近右侧时整层换到左侧。宿主仍占右缘但 pointer-events:none
     不参与命中测试，换侧只改 .panel 自身，边线与投影跟着镜像 */
  left: 0; right: auto;
  border-left: none; border-right: 1px solid #dadce0;
  box-shadow: 4px 0 16px rgba(0, 0, 0, 0.12);
}
.head {
  flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  background: #1a73e8; color: #fff; cursor: default; user-select: none;
}
.head .t { font-size: 14px; font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.head .k { font-size: 11px; opacity: 0.85; font-weight: 400; }
.head .x {
  flex: none; border: 0; background: transparent; color: #fff; font-size: 18px; line-height: 1;
  cursor: pointer; padding: 2px 6px; border-radius: 4px;
}
.head .x:hover { background: rgba(255, 255, 255, 0.18); }
.hint {
  flex: none; padding: 6px 12px; font-size: 12px; color: #5f6368;
  background: #f8f9fa; border-bottom: 1px solid #eee; line-height: 1.6;
}
.pickbar { flex: none; padding: 6px 12px; border-bottom: 1px solid #eee; }
.pick-again {
  width: 100%; border: 1px dashed #1a73e8; background: #fff; color: #1a73e8;
  font-size: 12px; padding: 5px 0; border-radius: 6px; cursor: pointer;
}
.pick-again:hover { background: #f1f6fe; }
.pick-again:disabled { color: #bdc1c6; border-color: #dadce0; cursor: default; background: #fafafa; }
.body { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; }
.section-title { font-size: 11px; color: #80868b; text-transform: uppercase; letter-spacing: 0.4px; margin: 2px 0 4px; }
.sel-box { border: 1px solid #dadce0; border-radius: 8px; padding: 8px 10px; background: #fafbfc; }
.sel-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: #5f6368; margin-bottom: 6px; }
.sel-meta b { color: #202124; font-weight: 600; }
.sel-box textarea {
  width: 100%; min-height: 44px; resize: vertical; border: 1px solid #dadce0; border-radius: 6px;
  font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: 12px; padding: 6px 8px;
  color: #174ea6; background: #fff; outline: none;
}
.sel-box textarea:focus { border-color: #1a73e8; }
.sel-actions { display: flex; gap: 6px; margin-top: 6px; align-items: center; }
.copy-btn {
  border: 1px solid #dadce0; background: #fff; color: #1a73e8; font-size: 12px;
  padding: 3px 10px; border-radius: 6px; cursor: pointer;
}
.copy-btn:hover { background: #f1f6fe; }
.copy-state { font-size: 11px; color: #188038; }
.warn { font-size: 11px; color: #d93025; margin-top: 6px; }
.empty { font-size: 12px; color: #80868b; padding: 2px 0 10px; text-align: center; }
.action-row { display: flex; flex-wrap: wrap; gap: 6px; }
.act {
  border: 1px solid #dadce0; background: #fff; color: #1a73e8; font-size: 12px;
  padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
}
.act:hover { background: #f1f6fe; }
.act:disabled { color: #bdc1c6; cursor: default; background: #fafafa; }
.act.run { background: #1a73e8; color: #fff; border-color: #1a73e8; font-weight: 500; }
.act.run:hover { background: #1765cc; }
.act.danger { color: #d93025; }
.param-row {
  display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 4px;
  border: 1px dashed #dadce0; border-radius: 6px; padding: 6px;
}
.param-row input {
  flex: 1; min-width: 100px; border: 1px solid #dadce0; border-radius: 6px;
  font-size: 12px; padding: 4px 8px; outline: none;
}
.param-row input:focus { border-color: #1a73e8; }
.param-row .lbl { font-size: 11px; color: #5f6368; }
.results { border-top: 1px solid #eee; padding-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.res-row { border: 1px solid #eee; border-radius: 6px; overflow: hidden; }
.res-head {
  display: flex; align-items: center; gap: 6px; padding: 3px 8px; font-size: 11px;
  background: #f8f9fa; color: #5f6368;
}
.res-head .ok { margin-left: auto; color: #188038; font-weight: 600; }
.res-head .bad { margin-left: auto; color: #d93025; font-weight: 600; }
.res-body {
  font-family: SFMono-Regular, Consolas, Menlo, monospace; font-size: 11px; color: #202124;
  padding: 6px 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all;
  max-height: 200px; overflow-y: auto;
}
.busy { font-size: 12px; color: #1a73e8; padding: 4px 2px; }
.status { font-size: 12px; padding: 8px 12px 0; color: #5f6368; }
.status.picking { color: #e8710a; }
.grp { display: flex; flex-direction: column; gap: 2px; }
`;

// 动作定义：group 决定哪些元素可用（common 通用 / edit 输入类 / file input[type=file] /
// drop 非 file-input / global 无选中也可用）
type ActionGroup = "common" | "edit" | "file" | "drop" | "global";
interface ActionDef {
  id: string;
  label: string;
  group: ActionGroup;
  needsLocatable: boolean;
  file?: boolean; // 需要先从磁盘选文件（file input / 拖拽区）
  params?: { key: string; label: string; def?: string; placeholder?: string }[];
}

const ACTIONS: ActionDef[] = [
  { id: "click", label: "点击", group: "common", needsLocatable: true },
  { id: "real_click", label: "真实点击", group: "common", needsLocatable: true },
  { id: "scrollTo", label: "滚到元素", group: "common", needsLocatable: true },
  { id: "type", label: "输入文字", group: "edit", needsLocatable: true, params: [{ key: "text", label: "文字", placeholder: "要输入的内容…" }] },
  { id: "key", label: "按键", group: "edit", needsLocatable: true, params: [{ key: "key", label: "按键", def: "Enter", placeholder: "如 Enter / Tab / a" }] },
  { id: "trigger", label: "触发事件", group: "edit", needsLocatable: true, params: [{ key: "event", label: "事件", def: "change", placeholder: "change / blur / input" }] },
  { id: "upload_file", label: "选择文件上传", group: "file", needsLocatable: true, file: true },
  { id: "upload_drop", label: "拖拽上传", group: "drop", needsLocatable: true, file: true },
  { id: "get_text", label: "读取文本", group: "common", needsLocatable: true },
  { id: "get_css", label: "读取样式", group: "common", needsLocatable: true },
  { id: "get_prop", label: "读取属性", group: "common", needsLocatable: true, params: [{ key: "prop", label: "属性", def: "value", placeholder: "如 value / checked / href" }] },
  { id: "show", label: "强制显示", group: "common", needsLocatable: true },
];

interface PanelResult {
  at: string;
  cmd: string;
  ok: boolean;
  text: string;
}

class DebugPanel {
  private root: ShadowRoot;
  private host: HTMLDivElement;
  private panelEl: HTMLElement | null = null; // .panel 主容器（躲鼠标换侧用）
  private paramRowEl: HTMLElement | null = null; // 当前参数输入行（Esc 取消该行时定位用）
  private fileInput: HTMLInputElement;
  private el: Record<string, HTMLElement> = {};
  private sel: Selection | null = null;
  private locatable = false;
  private results: PanelResult[] = [];
  private executing = false;
  private picking = false;
  private copyTimer = 0;
  private busySeq = 0;
  destroyed = false;

  constructor(
    private readonly onClose: () => void,
    private readonly onPickAgain: () => void,
    private readonly runInFrame: (command: string, params: Record<string, unknown>, chain: ChainHop[]) => Promise<BridgeResult>,
    private readonly broadcast: (command: string) => Promise<BridgeResult>,
    // chain 一起带上：SW 点击后向元素所在 frame 发 settle（与远程 real_click 命中帧语义一致）
    private readonly realClick: (x: number, y: number, chain: ChainHop[]) => Promise<BridgeResult>,
  ) {
    this.host = document.createElement("div");
    this.host.setAttribute("data-cda-debug-host", "1");
    this.host.style.cssText = `all:initial;position:fixed;top:0;right:0;bottom:0;width:${PANEL_W}px;z-index:2147483647;pointer-events:none;`;
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    this.root.appendChild(style);
    const dom = this.buildDom();
    this.panelEl = dom;
    this.root.appendChild(dom);
    (document.body || document.documentElement).appendChild(this.host);
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.style.display = "none";
    this.root.appendChild(this.fileInput);
    // 监听挂 shadow root 而不挂宿主：root 与按钮同树，事件不跨 shadow 边界 → target
    // 不被重定向（挂宿主的监听 target 会被重定向成宿主自身，closest 就全失效）。
    // change 不 composed，根本不穿透 shadow 边界到宿主 → 直接挂 fileInput 自身。
    this.root.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      const x = target.closest?.(".x");
      if (x) {
        this.onClose();
        return;
      }
      const btn = target.closest?.(".pick-again") as HTMLElement | null;
      if (btn) {
        this.onPickAgain();
        return;
      }
      const act = target.closest?.("[data-act]") as HTMLElement | null;
      if (act) {
        const id = act.getAttribute("data-act")!;
        this.runAction(id);
        return;
      }
    });
    this.fileInput.addEventListener("change", () => {
      const pending = (this.fileInput as HTMLInputElement & { _cdaCmd?: string })._cdaCmd;
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (!pending || !file) return;
      this.execFileAction(pending, file);
    });
  }

  private buildDom(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "panel";
    wrap.innerHTML = `
      <div class="head">
        <div class="t">调试模式 <span class="k">(⌘]/Ctrl+] 开关)</span></div>
        <button class="x" title="关闭（Esc / ⌘+]/Ctrl+]）">×</button>
      </div>
      <div class="status">准备中…</div>
      <div class="pickbar">
        <button class="pick-again">重新选择元素</button>
      </div>
      <div class="body">
        <div class="hint" data-part="pickHint">
          点击页面元素选中，悬停有坐标预览（支持 iframe 内与 shadow DOM 内元素；跨域 iframe 内部不支持）。选择期页面点击被拦停、不会触发页面；Esc / × 关闭浮层。
        </div>
        <div data-part="selection" style="display:none"></div>
        <div data-part="actions" style="display:none"></div>
        <div class="results" data-part="results"></div>
      </div>`;
    const map = (part: string) => wrap.querySelector(`[data-part="${part}"]`) as HTMLElement;
    this.el.selection = map("selection");
    this.el.actions = map("actions");
    this.el.results = map("results");
    this.el.pickHint = map("pickHint") as HTMLElement;
    this.el.pickBtn = wrap.querySelector(".pick-again") as unknown as HTMLButtonElement;
    const status = wrap.querySelector(".status") as HTMLElement;
    this.el.status = status;

    // —— 动作区（预生成按钮，按元素类型启停）——
    const actions = document.createElement("div");
    const groups: { id: ActionGroup; title: string }[] = [
      { id: "common", title: "通用操作" },
      { id: "edit", title: "输入操作" },
      { id: "file", title: "文件上传" },
      { id: "drop", title: "拖拽上传" },
      { id: "global", title: "全局" },
    ];
    for (const g of groups) {
      const sec = document.createElement("div");
      sec.className = "grp";
      const title = document.createElement("div");
      title.className = "section-title";
      title.textContent = g.title;
      sec.appendChild(title);
      const row = document.createElement("div");
      row.className = "action-row";
      const defs = ACTIONS.filter((a) => a.group === g.id);
      if (g.id === "global") {
        const btn = document.createElement("button");
        btn.className = "act run";
        btn.textContent = "还原页面显示 (hide)";
        btn.setAttribute("data-act", "hide");
        row.appendChild(btn);
      } else {
        for (const a of defs) {
          const btn = document.createElement("button");
          btn.className = "act";
          btn.textContent = a.label;
          btn.setAttribute("data-act", a.id);
          btn.title = a.id;
          row.appendChild(btn);
        }
      }
      sec.appendChild(row);
      actions.appendChild(sec);
    }
    this.el.actions.append(actions);
    return wrap;
  }

  // ========== 会话 UI ==========
  enterPicking(): void {
    this.picking = true;
    this.sel = null;
    this.locatable = false;
    this.setStatus("选择模式：点击页面元素选中（Esc 关闭浮层）", true);
    this.el.pickHint.style.display = "";
    this.el.selection.style.display = "none";
    this.el.actions.style.display = "none";
    if (this.el.pickBtn) (this.el.pickBtn as HTMLButtonElement).disabled = true;
  }

  exitPickNoSelect(): void {
    this.picking = false;
    this.setStatus("已取消选择，未选中元素。点「重新选择元素」继续。", false);
    this.el.pickHint.style.display = "";
    if (this.el.pickBtn) (this.el.pickBtn as HTMLButtonElement).disabled = false;
  }

  applySelection(sel: Selection, locatable: boolean): void {
    this.picking = false;
    this.sel = sel;
    this.locatable = locatable;
    this.setStatus("已选中元素，选择下方动作执行", false);
    this.el.pickHint.style.display = "none";
    if (this.el.pickBtn) (this.el.pickBtn as HTMLButtonElement).disabled = false;
    this.renderSelection();
    this.renderActions();
  }

  hasParamRow(): boolean {
    return !!this.paramRowEl;
  }

  removeParamRow(): void {
    const row = this.paramRowEl;
    this.paramRowEl = null;
    if (row) row.remove();
  }

  // 躲鼠标：picking 期浮层整体在左右侧之间切换（由 controller 的 mousemove 驱动）
  setPanelSide(side: "right" | "left"): void {
    if (this.panelEl) this.panelEl.classList.toggle("side-left", side === "left");
  }

  private setStatus(text: string, picking: boolean): void {
    this.el.status.textContent = text;
    this.el.status.className = picking ? "status picking" : "status";
  }

  private renderSelection(): void {
    const s = this.sel!;
    const box = document.createElement("div");
    box.className = "sel-box";
    const meta = document.createElement("div");
    meta.className = "sel-meta";
    const where = s.chain.length === 0 ? "顶层页面" : `iframe 内元素（${s.chain.length} 层）`;
    meta.innerHTML = "";
    const add = (k: string, v: string) => {
      const span = document.createElement("span");
      const b = document.createElement("b");
      b.textContent = v;
      span.append(`${k} `, b);
      meta.appendChild(span);
    };
    add("元素", `<${s.tag}>`);
    if (s.type) add("type", s.type);
    add("位置", where);
    add("点击坐标", `(${s.clickX}, ${s.clickY})`);
    box.appendChild(meta);
    const ta = document.createElement("textarea");
    ta.value = s.selector;
    ta.readOnly = true;
    ta.title = "完整 CSS 选择器（含 shadow 穿透 >>> 段）";
    box.appendChild(ta);
    const row = document.createElement("div");
    row.className = "sel-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "复制选择器";
    const copyState = document.createElement("span");
    copyState.className = "copy-state";
    copyState.style.display = "none";
    const flash = () => {
      copyState.textContent = "已复制";
      copyState.style.display = "";
      window.clearTimeout(this.copyTimer);
      this.copyTimer = window.setTimeout(() => (copyState.style.display = "none"), 1500);
    };
    copyBtn.addEventListener("click", () => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(s.selector).then(flash).catch(() => {
          ta.select(); // 剪贴板权限受限时退化为选中文本
          flash();
        });
      } else {
        ta.select();
        flash();
      }
    });
    row.append(copyBtn, copyState);
    box.appendChild(row);
    if (!this.locatable) {
      const warn = document.createElement("div");
      warn.className = "warn";
      warn.textContent = "该元素当前无法用选择器二次定位（closed shadow 内部或页面已变化）——上方动作已置灰，请重新选择。";
      box.appendChild(warn);
    }
    this.el.selection.replaceChildren(box);
    this.el.selection.style.display = "";
  }

  private renderActions(): void {
    const s = this.sel;
    this.el.actions.style.display = s ? "" : "none";
    if (!s) return;
    const isFile = s.tag === "input" && s.type === "file";
    const avail = (a: ActionDef): boolean => {
      if (!this.locatable && a.needsLocatable) return false;
      switch (a.group) {
        case "common": return true;
        case "edit": return s.editable;
        case "file": return isFile;
        case "drop": return !isFile;
        default: return true;
      }
    };
    for (const btn of this.el.actions.querySelectorAll("[data-act]") as NodeListOf<HTMLButtonElement>) {
      const def = ACTIONS.find((a) => a.id === btn.getAttribute("data-act"));
      const available = def ? avail(def) : btn.getAttribute("data-act") === "hide";
      btn.disabled = !available || this.executing;
    }
  }

  // ========== 动作执行 ==========
  private runAction(id: string): void {
    if (!this.sel || this.executing) return;
    if (id === "hide") {
      this.exec(this.broadcast("hide"), "hide");
      return;
    }
    const def = ACTIONS.find((a) => a.id === id);
    if (!def) return;
    if (def.file) {
      this.pickFile(id);
      return;
    }
    if (def.params && def.params.length > 0) {
      this.openParamRow(def);
      return;
    }
    this.execActionNoParams(id);
  }

  // 无参数动作直接执行
  private execActionNoParams(id: string): void {
    if (!this.sel) return;
    const s = this.sel;
    switch (id) {
      case "click":
        this.exec(this.runInFrame("click", { selector: s.selector }, s.chain), "click");
        break;
      case "scrollTo":
        this.exec(this.runInFrame("scroll", { selector: s.selector, block: "center" }, s.chain), "scroll");
        break;
      case "get_text":
        this.exec(this.runInFrame("get_text", { selector: s.selector }, s.chain), "get_text");
        break;
      case "get_css":
        this.exec(this.runInFrame("get_css", { selector: s.selector }, s.chain), "get_css");
        break;
      case "show":
        this.exec(this.runInFrame("show", { selector: s.selector }, s.chain), "show");
        break;
      case "real_click":
        this.execRealClick();
        break;
      default:
        break;
    }
  }

  private pickFile(actionId: string): void {
    const input = this.fileInput as HTMLInputElement & { _cdaCmd?: string };
    input._cdaCmd = actionId;
    // 用户手势内打开系统文件选择器
    try {
      input.click();
    } catch {
      this.addResult(actionId, false, "无法打开文件选择器");
    }
  }

  private execFileAction(actionId: string, file: File): void {
    const s = this.sel;
    if (!s) return;
    const reader = new FileReader();
    reader.onerror = () => this.addResult(actionId, false, "文件读取失败");
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : "";
      const filename = file.name;
      const mime = file.type || "";
      if (actionId === "upload_file") {
        this.exec(this.runInFrame("upload_file", { selector: s.selector, base64, filename, mime }, s.chain), "upload_file");
      } else {
        this.exec(this.runInFrame("upload_dragdrop", { selector: s.selector, data: { base64, filename, mime } }, s.chain), "upload_dragdrop");
      }
    };
    reader.readAsDataURL(file);
  }

  private openParamRow(def: ActionDef): void {
    if (!this.sel || !def.params) return;
    this.removeParamRow(); // 同根只留一行（点其他参数动作时顶掉旧行）
    const row = document.createElement("div");
    row.className = "param-row";
    const values: Record<string, HTMLInputElement> = {};
    for (const p of def.params) {
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = p.label;
      const input = document.createElement("input");
      input.placeholder = p.placeholder ?? "";
      if (p.def) input.value = p.def;
      values[p.key] = input;
      row.append(lbl, input);
    }
    const okBtn = document.createElement("button");
    okBtn.className = "act run";
    okBtn.textContent = "执行";
    okBtn.addEventListener("click", () => {
      const params: Record<string, unknown> = {};
      for (const p of def.params!) {
        const v = values[p.key].value;
        params[p.key] = p.def && v === "" ? p.def : v;
      }
      this.removeParamRow();
      this.execParamsAction(def.id, params);
    });
    const cancel = document.createElement("button");
    cancel.className = "act";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => this.removeParamRow());
    row.append(okBtn, cancel);
    // 回车执行；Esc 取消本行（正常模型下 Esc 被主世界拦停中继给 controller 处理，
    // 由 ESC_EVT detail.host 命中本行后 removeParamRow——这里是主世界缺席时的兜底路径）
    for (const input of Object.values(values)) {
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") okBtn.click();
        if (ev.key === "Escape") this.removeParamRow();
      });
    }
    this.paramRowEl = row;
    this.el.actions.appendChild(row);
    const first = Object.values(values)[0];
    if (first) first.focus();
  }

  private execParamsAction(id: string, params: Record<string, unknown>): void {
    const s = this.sel;
    if (!s) return;
    const base: Record<string, unknown> = { selector: s.selector };
    switch (id) {
      case "type": {
        const text = String(params.text ?? "");
        if (!text) {
          this.addResult("type", false, "请输入要输入的文字");
          return;
        }
        this.exec(this.runInFrame("type", { ...base, text, mode: "replace" }, s.chain), "type");
        break;
      }
      case "key":
        this.exec(this.runInFrame("keyboard", { ...base, key: String(params.key ?? "Enter") }, s.chain), "keyboard");
        break;
      case "trigger": {
        const p: Record<string, unknown> = { ...base, event: String(params.event ?? "change") };
        const value = params.value;
        if (value !== "" && value !== undefined) p.value = value;
        this.exec(this.runInFrame("trigger", p, s.chain), "trigger");
        break;
      }
      case "get_prop":
        this.exec(this.runInFrame("get_prop", { ...base, prop: String(params.prop ?? "value") }, s.chain), "get_prop");
        break;
      default:
        break;
    }
  }

  private execRealClick(): void {
    const s = this.sel!;
    this.setBusy("正在计算真实点击坐标（滚动到元素）…");
    this.runInFrame("get_rect", { selector: s.selector, scroll: true }, s.chain)
      .then((rect) => {
        if (!rect.success || typeof rect.data !== "object" || rect.data === null) {
          this.addResult("real_click", false, String(rect.error ?? "无法定位元素坐标"));
          this.setBusy(null);
          return;
        }
        const d = rect.data as { x?: number; y?: number };
        if (typeof d.x !== "number" || typeof d.y !== "number") {
          this.addResult("real_click", false, "定位响应缺少坐标");
          this.setBusy(null);
          return;
        }
        // 目标在视口外（如外层 iframe 已滚出可视区）：坐标点击会落空，先如实警告
        if (d.x < 0 || d.y < 0 || d.x > window.innerWidth || d.y > window.innerHeight) {
          this.addResult("real_click", false, `目标位于可视区外 (${d.x}, ${d.y})——外层 iframe 可能已滚出页面，真实点击会落空。请滚动页面后重试。`);
          this.setBusy(null);
          return;
        }
        // 面板临时隐藏：真实鼠标落点不能被面板遮住
        this.host.style.visibility = "hidden";
        this.busySeq++;
        const seq = this.busySeq;
        const fire = () => {
          this.realClick(d.x!, d.y!, s.chain)
            .then((r) => {
              if (seq !== this.busySeq) return;
              this.host.style.visibility = "visible";
              this.addResult(
                "real_click",
                r.success,
                r.success
                  ? `(${d.x}, ${d.y}) trusted 点击完成\n${stringifyData(r.data ?? {})}`
                  : String(r.error ?? "真实点击失败"),
              );
              this.setBusy(null);
            })
            .catch((err) => {
              if (seq !== this.busySeq) return;
              this.host.style.visibility = "visible";
              this.addResult("real_click", false, `真实点击异常: ${err instanceof Error ? err.message : String(err)}`);
              this.setBusy(null);
            });
        };
        // 双 rAF 让面板隐藏后的布局稳定（面板是 fixed，本身不影响布局，纯保险）
        requestAnimationFrame(() => requestAnimationFrame(fire));
      })
      .catch((err) => {
        this.addResult("real_click", false, `坐标计算异常: ${err instanceof Error ? err.message : String(err)}`);
        this.setBusy(null);
      });
  }

  private exec(p: Promise<BridgeResult>, cmdLabel: string): void {
    this.setBusy(`正在执行 ${cmdLabel} …`);
    p.then((r) => {
      if (r.success) {
        this.addResult(cmdLabel, true, stringifyData(r.data ?? { ok: true }));
      } else {
        this.addResult(cmdLabel, false, String(r.error ?? "未知错误"));
      }
      this.setBusy(null);
    }).catch((err) => {
      this.addResult(cmdLabel, false, `执行异常: ${err instanceof Error ? err.message : String(err)}`);
      this.setBusy(null);
    });
  }

  private setBusy(text: string | null): void {
    this.executing = text != null;
    this.renderActions();
    const div = this.el.actions.querySelector<HTMLElement>(".busy");
    if (text == null) {
      if (div) div.remove();
    } else if (div) {
      div.textContent = text;
    } else {
      const busy = document.createElement("div");
      busy.className = "busy";
      busy.textContent = text;
      this.el.actions.appendChild(busy);
    }
  }

  private addResult(cmd: string, ok: boolean, text: string): void {
    if (this.destroyed) return;
    this.results.push({ at: fmtTime(), cmd, ok, text });
    if (this.results.length > 50) this.results.shift();
    const row = document.createElement("div");
    row.className = "res-row";
    const head = document.createElement("div");
    head.className = "res-head";
    head.textContent = `${this.results[this.results.length - 1].at}  ${cmd}`;
    const badge = document.createElement("span");
    badge.className = ok ? "ok" : "bad";
    badge.textContent = ok ? "成功" : "失败";
    head.appendChild(badge);
    const body = document.createElement("div");
    body.className = "res-body";
    body.textContent = text;
    row.append(head, body);
    const resultsBox = this.el.results;
    resultsBox.appendChild(row);
    resultsBox.scrollTop = resultsBox.scrollHeight;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.fileInput) this.fileInput.remove();
    this.host.remove();
  }
}

// —— 顶层会话控制器 ——
class DebugController {
  private panel: DebugPanel | null = null;
  private picker: FramePicker | null = null;
  private session: "idle" | "picking" | "closed" = "closed";
  private pendingProbe = 0; // 可定位性探测序号：探测返回时若已进入新会话/新选择则丢弃
  private dodgeSide: "right" | "left" = "right"; // 浮层躲鼠标当前侧（picking 期联动）

  constructor() {
    this.picker = new FramePicker(true);
    // 浮层可见期（picking/iso）主世界把页面 Esc 拦停后中继到本帧文档：Esc 语义统一为
    // 「焦点在参数输入行 → 只取消该行；否则关闭浮层」。registered 于会话开始前（本构造
    // 先于 picker attach），同一次中继先于 picker 的 ESC 监听执行，关闭路径一次走完
    document.addEventListener(ESC_EVT, this.onEscRelayTop);
  }

  private readonly onEscRelayTop = (ev: Event): void => {
    if (!this.panel) return;
    const d = (ev as CustomEvent).detail as { host?: boolean } | undefined;
    if (d && d.host === true && this.panel.hasParamRow()) {
      // 焦点在参数输入行：Esc 只取消该行（行内 Esc 的兜底路径见 openParamRow）
      this.panel.removeParamRow();
      return;
    }
    this.closePanel();
  };

  private readonly onDodgeMove = (ev: Event): void => {
    const panel = this.panel;
    if (!panel) return;
    const x = (ev as MouseEvent).clientX;
    const w = window.innerWidth;
    if (this.dodgeSide === "right") {
      // 光标逼近右缘面板区 → 浮层让到左侧，不再遮挡右侧页面
      if (x >= w - PANEL_W) {
        this.dodgeSide = "left";
        panel.setPanelSide("left");
      }
    } else if (x < PANEL_W || x < w - PANEL_W - DODGE_HYST) {
      // 光标离开右侧区（或逼近左置的浮层）→ 回右侧；带滞回带防右缘小范围抖动
      this.dodgeSide = "right";
      panel.setPanelSide("right");
    }
  };

  toggle(): void {
    if (this.panel) {
      this.closePanel();
    } else {
      this.openPanel();
    }
  }

  private openPanel(): void {
    this.panel = new DebugPanel(
      () => this.closePanel(),
      () => this.enterPicking(),
      (command, params, chain) => this.runCommand(command, params, chain),
      (command) => this.runBroadcast(command),
      (x, y, chain) => this.runRealClick(x, y, chain),
    );
    this.enterPicking();
  }

  private closePanel(): void {
    if (!this.panel) return;
    this.leavePicking();
    this.panel.destroy();
    this.panel = null;
    this.broadcastState("closed");
  }

  private leavePicking(): void {
    // 面板/会话彻底结束：停选择器、清空本帧一切覆盖物、关拦截、停躲鼠标
    this.pendingProbe++; // 丢弃在途探测结果
    this.session = "closed";
    this.picker!.dispose();
    setIntercept(false, false);
    window.removeEventListener("mousemove", this.onDodgeMove, true);
  }

  private enterPicking(): void {
    if (!this.panel) return;
    if (this.session !== "picking") {
      // 新选择会话：旧选择的覆盖物/结果全部作废；浮层回右侧并开始躲鼠标
      this.pendingProbe++;
      this.session = "picking";
      this.picker!.startPicking((sel) => this.onLocalPick(sel), (reason) => this.onPickerAbort(reason));
      setIntercept(true, true);
      this.broadcastState("picking");
      this.dodgeSide = "right";
      this.panel.setPanelSide("right");
      window.addEventListener("mousemove", this.onDodgeMove, true);
    }
    this.panel.enterPicking();
  }

  private cancelPicking(): void {
    if (!this.panel || this.session !== "picking") return;
    this.pendingProbe++;
    this.session = "idle";
    this.picker!.stopPicking();
    setIntercept(false, true);
    this.panel.exitPickNoSelect();
    this.broadcastState("idle");
    window.removeEventListener("mousemove", this.onDodgeMove, true);
  }

  // 选择器会话中止（relay 与原生兜底两路都汇到这里）：reason=esc → 关闭浮层（Esc 语义
  // 统一为关闭，正常模型下 relay 路径已由 onEscRelayTop 先行关闭，这里兜 native Esc）；
  // reason=fail（桥缺失等）→ 留在面板，仅退出选择并提示
  private onPickerAbort(reason: "esc" | "fail"): void {
    if (!this.panel) return;
    if (reason === "esc") {
      this.closePanel();
    } else if (this.session === "picking") {
      this.cancelPicking();
    }
  }

  private onLocalPick(sel: Selection): void {
    sel.sourceFrameId = 0;
    this.onPick(sel);
  }

  // 子 frame 上报的选择/Esc（SW 按 tabId 转发到顶层帧，sourceFrameId 标记来源帧）
  onRemotePick(payload: Selection | undefined, sourceFrameId: number | undefined): void {
    if (!payload) return;
    payload.sourceFrameId = typeof sourceFrameId === "number" ? sourceFrameId : 0;
    this.onPick(payload);
  }

  private onPick(sel: Selection): void {
    if (!this.panel || this.session !== "picking") return;
    this.pendingProbe++;
    this.session = "idle";
    this.picker!.stopPicking();
    setIntercept(false, true);
    this.broadcastState("idle");
    window.removeEventListener("mousemove", this.onDodgeMove, true);
    // 立即上屏（locatable 未定 → 动作先置灰），随后探测修正
    this.panel.applySelection(sel, false);
    const seq = this.pendingProbe;
    this.probeLocatable(sel.chain, sel.selector)
      .then((ok) => {
        if (seq !== this.pendingProbe || !this.panel || this.panel.destroyed) return;
        if (ok) this.panel.applySelection(sel, true); // 仍不可定位则维持置灰提示
      })
      .catch(() => {
        // 探测失败按不可定位处理（已置灰，无需动作）
      });
  }

  // 子 frame 上报的 Esc / 中止（子帧主世界把该帧 Esc 拦停中继 → 子会话经 SW 上报）：
  // reason=esc → 关闭浮层（焦点留在 iframe 内时 Esc 也能关面板）；fail（子帧探测失败）→
  // 仅退出选择会话、面板保留提示
  onEscFromChild(reason?: string): void {
    if (!this.panel) return;
    if (reason === "fail") {
      if (this.session === "picking") this.cancelPicking();
      return;
    }
    this.closePanel();
  }

  // 面板操作路由：选中元素可能在子 frame —— 顶层走本地桥，其余经 SW 逐跳解析执行
  private runCommand(command: string, params: Record<string, unknown>, chain: ChainHop[]): Promise<BridgeResult> {
    if (chain.length === 0) {
      const bridge = getBridge();
      if (!bridge) return Promise.resolve({ success: false, error: "content script 桥不可用" });
      return bridge.handleCommand({ command, params });
    }
    return chrome.runtime
      .sendMessage({ type: "debug_execute", payload: { command, params, chain } })
      .then((r) => (r as BridgeResult) ?? { success: false, error: "service worker 未响应" })
      .catch((err) => ({ success: false, error: `debug_execute 失败: ${err instanceof Error ? err.message : String(err)}` }));
  }

  private runBroadcast(command: string): Promise<BridgeResult> {
    return chrome.runtime
      .sendMessage({ type: "debug_broadcast", payload: { command } })
      .then((r) => (r as BridgeResult) ?? { success: false, error: "service worker 未响应" })
      .catch((err) => ({ success: false, error: `debug_broadcast 失败: ${err instanceof Error ? err.message : String(err)}` }));
  }

  private runRealClick(x: number, y: number, chain: ChainHop[]): Promise<BridgeResult> {
    return chrome.runtime
      .sendMessage({ type: "debug_real_click", payload: { x, y, chain } })
      .then((r) => (r as BridgeResult) ?? { success: false, error: "service worker 未响应" })
      .catch((err) => ({ success: false, error: `debug_real_click 失败: ${err instanceof Error ? err.message : String(err)}` }));
  }

  private probeLocatable(chain: ChainHop[], selector: string): Promise<boolean> {
    // get_rect 是只读定位探针：目标 frame 能解析该选择器即视为可定位
    if (!selector) return Promise.resolve(false);
    return this.runCommand("get_rect", { selector }, chain)
      .then((r) => r.success === true && !r.notFound)
      .catch(() => false);
  }

  private broadcastState(state: "picking" | "idle" | "closed"): void {
    chrome.runtime
      .sendMessage({ type: "debug_mode", payload: { state } })
      .catch(() => {});
  }
}

// —— 非顶层实例：子 frame 选择器（跨域不可选时静默停用）——
// 本帧主世界拦截状态机：broadcast picking → picker 同源探测成功后 attach 置 (true,false)
// 吞本帧页面点击/Esc（探测失败的本帧不开拦截，页面保持原样——同源探测失败是 oracle 故障
// 的罕见情形）；回 idle → picker detach 置 (false,true)：页面点击还原、Esc 继续归浮层
// （焦点留在 iframe 内时 Esc 也能关顶层浮层）；closed → dispose 补 (false,false) 全关。
class ChildSession {
  private picker: FramePicker | null = null;
  private picking = false;

  constructor() {
    this.picker = new FramePicker(false);
    // idle 期 Esc 中继：主世界把本帧 Esc 拦停后中继 ESC_EVT → 上报顶层关闭浮层。
    // picking 期的 Esc 由 picker 会话路径上报（本监听按 picking 跳过，避免双报）
    document.addEventListener(ESC_EVT, this.onEscRelay);
  }

  private readonly onEscRelay = (): void => {
    if (this.picking) return;
    this.reportEsc("esc");
  };

  startPicking(): void {
    if (this.picking) return;
    this.picking = true;
    this.picker!.startPicking((sel) => this.report(sel), (reason) => this.onPickerAbort(reason));
  }

  stopPicking(): void {
    if (!this.picking) return;
    this.picking = false;
    // 内部 detach 把本帧拦截置回 (false,true)：页面活性还原、Esc 仍归浮层（idle 语义）
    this.picker!.stopPicking();
  }

  dispose(): void {
    this.picking = false;
    this.picker!.dispose();
    setIntercept(false, false); // 收掉 detach 留下的 iso=true——面板已关，页面完全还原
  }

  // picker 会话中止（pick 之外的结束路径）：还原本帧状态并上报顶层（顶层按 reason 决定
  // 关闭浮层或仅退出选择）
  private onPickerAbort(reason: "esc" | "fail"): void {
    if (!this.picking) return;
    this.picking = false;
    this.reportEsc(reason);
  }

  private report(sel: Selection): void {
    chrome.runtime
      .sendMessage({ type: "debug_pick_selected", payload: sel })
      .catch(() => {});
  }

  private reportEsc(reason: "esc" | "fail"): void {
    chrome.runtime
      .sendMessage({ type: "debug_pick_esc", payload: { reason } })
      .catch(() => {});
  }
}

// ============================ 每帧入口 ============================
// 事件名与 main-world.ts 对齐；所有监听一律 try/catch，不抛错进页面。
const controller = IS_TOP ? new DebugController() : null;
const childSession = IS_TOP ? null : new ChildSession();

// —— 各 frame 状态广播处理 ——
// 顶层（controller 侧）的状态机由面板流程本地驱动，广播只用于驱动非顶层帧；
// 顶层收到自己的广播回声时各组件早已处于目标状态（启动/停止均幂等）。
function applySession(state: string): void {
  if (IS_TOP) return;
  const cs = childSession;
  if (!cs) return;
  if (state === "picking") cs.startPicking();
  else if (state === "idle") cs.stopPicking();
  else if (state === "closed") cs.dispose();
}

chrome.runtime.onMessage.addListener(
  (msg: { type?: string; payload?: Record<string, unknown>; sourceFrameId?: number }, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    try {
      if (msg.type === "debug_mode") {
        const state = (msg.payload as { state?: string } | undefined)?.state ?? "";
        applySession(state);
        sendResponse?.({ ok: true });
        return true;
      }
      if (IS_TOP && msg.type === "debug_pick_selected") {
        controller?.onRemotePick(msg.payload as Selection | undefined, msg.sourceFrameId);
        sendResponse?.({ ok: true });
        return true;
      }
      if (IS_TOP && msg.type === "debug_pick_esc") {
        const payload = msg.payload as { reason?: string } | undefined;
        controller?.onEscFromChild(payload?.reason);
        sendResponse?.({ ok: true });
        return true;
      }
    } catch {
      // 选择器故障不影响页面
    }
    return;
  },
);

// —— 顶层快捷键开关（主世界转发的 toggle 到达本世界；child 帧不注册）——
// 主世界：顶层本帧按键直接派发 plain toggle；子 frame 按键派发 {viaChild:true}，
// 顶层主世界收到后重派发 plain toggle → 这里只收到 plain 版本，恰好触发一次。
if (IS_TOP && controller) {
  document.addEventListener(TOGGLE_EVT, (ev: Event) => {
    try {
      const detail = (ev as CustomEvent).detail as { viaChild?: boolean } | undefined;
      if (detail?.viaChild) return;
      controller.toggle();
    } catch {
      // 忽略
    }
  });
}

// 页面自身卸载/刷新时一切随文档销毁自然重置（content script 随文档重载），无需清场逻辑。

})();
