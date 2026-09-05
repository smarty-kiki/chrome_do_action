"use strict";
(() => {
  // src/content/debug-mode.ts
  (() => {
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
    function getBridge() {
      const b = window.__cdaDebug;
      return b && typeof b.handleCommand === "function" && typeof b.genSelector === "function" ? b : null;
    }
    const PANEL_W = 320;
    const MAX_RESULT_CHARS = 4e3;
    function stringifyData(d) {
      let s;
      try {
        s = JSON.stringify(d, null, 1);
      } catch {
        s = String(d);
      }
      if (s == null) s = "undefined";
      return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `
\u2026\uFF08\u622A\u65AD\uFF0C\u5171 ${s.length} \u5B57\u7B26\uFF09` : s;
    }
    function fmtTime() {
      const d = /* @__PURE__ */ new Date();
      const p = (n) => String(n).padStart(2, "0");
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
    function hitsDebugHost(path) {
      return path.some((n) => n instanceof Element && n.getAttribute?.("data-cda-debug-host") != null);
    }
    function isEditableEl(el) {
      const tag = el.tagName.toLowerCase();
      if (tag === "textarea" || tag === "select") return true;
      if (tag === "input") {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        return /^(text|search|url|tel|email|password|number|date|time|datetime-local|month|week)$/.test(t);
      }
      return el.isContentEditable === true;
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
    function makeOverlay() {
      if (!document.documentElement) return null;
      const host = document.createElement("div");
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
    class GeoClient {
      constructor() {
        this.seq = 0;
        this.pending = /* @__PURE__ */ new Map();
        this.cache = null;
        // 最近一次成功/失败结果
        this.lastAt = 0;
        this.TIMEOUT_MS = 250;
        const onReply = (detail) => {
          const d = detail;
          if (typeof d?.requestId !== "number") return;
          const resolve = this.pending.get(d.requestId);
          if (!resolve) return;
          this.pending.delete(d.requestId);
          const result = d.ok === true ? { ok: true, chain: d.chain, ox: d.ox, oy: d.oy } : { ok: false, crossOrigin: d.crossOrigin === true };
          this.cache = result;
          resolve(result);
        };
        document.addEventListener(GEO_REPLY_EVT, (ev) => onReply(ev.detail));
        window.addEventListener("message", (ev) => {
          const m = ev.data;
          if (m && typeof m === "object" && m.__cdaMain === GEO_REPLY_EVT) onReply(m.detail);
        });
      }
      probe() {
        const requestId = ++this.seq;
        const result = new Promise((resolve) => {
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
      refreshThrottled() {
        if (Date.now() - this.lastAt < 150) return;
        this.probe().catch(() => {
        });
      }
    }
    function dispatchMain(type, detail) {
      try {
        document.dispatchEvent(new CustomEvent(type, { detail }));
      } catch {
      }
      try {
        window.postMessage({ __cdaMain: type, detail }, "*");
      } catch {
      }
    }
    function setIntercept(picking, iso) {
      dispatchMain(INTERCEPT_EVT, { picking, iso });
    }
    class FramePicker {
      constructor(forTop) {
        this.forTop = forTop;
        this.overlay = null;
        this.active = false;
        this.attached = false;
        // overlay DOM 与事件监听各自独立：会话间复用 DOM，进出 picking 只增删监听
        this.chain = [];
        this.offset = { ox: 0, oy: 0 };
        this.offsetReady = false;
        // 非顶层探测成功前不画坐标片（避免局部坐标冒充顶层坐标）
        this.geo = new GeoClient();
        this.hoverEl = null;
        this.ringTarget = null;
        // 选中后需要保持的框
        this.ringTimer = 0;
        this.onSelectCb = null;
        this.onEscCb = null;
        this.onMove = (ev) => this.handleMove(ev);
        this.onClick = (ev) => this.handleClick(ev);
        this.onOut = (ev) => this.handleOut(ev);
        this.onKey = (ev) => this.handleKey(ev);
        this.onScroll = () => this.repositionAll();
        this.onResize = () => this.repositionAll();
      }
      // —— 会话生命周期（由 debug_mode 广播驱动，幂等）——
      startPicking(onSelect, onEsc) {
        if (this.active) return;
        this.onSelectCb = onSelect;
        this.onEscCb = onEsc;
        this.active = true;
        this.clearRing();
        this.hideChip();
        if (this.forTop) {
          this.chain = [];
          this.offset = { ox: 0, oy: 0 };
          this.offsetReady = true;
          this.attach();
          return;
        }
        this.offsetReady = false;
        this.geo.probe().then((r) => {
          if (!this.active) return;
          if (!r.ok) {
            this.clearCallbacks();
            this.active = false;
            return;
          }
          this.chain = r.chain;
          this.offset = { ox: r.ox, oy: r.oy };
          this.offsetReady = true;
          this.attach();
        }).catch(() => {
          this.clearCallbacks();
          this.active = false;
        });
      }
      stopPicking() {
        if (!this.active) return;
        this.active = false;
        this.detach();
        this.hoverEl = null;
        this.hideChip();
        if (this.overlay) this.overlay.hover.style.display = "none";
      }
      // 会话结束（面板关闭）：选择器与所有框全清
      dispose() {
        this.active = false;
        this.detach();
        this.clearCallbacks();
        this.clearRing();
      }
      clearCallbacks() {
        this.onSelectCb = null;
        this.onEscCb = null;
      }
      attach() {
        if (this.attached) return;
        if (!this.overlay) this.overlay = makeOverlay();
        if (!this.overlay) return;
        this.attached = true;
        if (!this.forTop) setIntercept(true, false);
        window.addEventListener("mousemove", this.onMove, true);
        window.addEventListener("click", this.onClick, true);
        window.addEventListener("mouseout", this.onOut, true);
        window.addEventListener("keydown", this.onKey, true);
        window.addEventListener("scroll", this.onScroll, true);
        window.addEventListener("resize", this.onResize);
      }
      detach() {
        if (!this.attached) return;
        this.attached = false;
        if (!this.forTop) setIntercept(false, false);
        window.removeEventListener("mousemove", this.onMove, true);
        window.removeEventListener("click", this.onClick, true);
        window.removeEventListener("mouseout", this.onOut, true);
        window.removeEventListener("keydown", this.onKey, true);
        window.removeEventListener("scroll", this.onScroll, true);
        window.removeEventListener("resize", this.onResize);
      }
      // —— 事件处理（只处理本 frame 文档内的事件：子 frame 内容事件到不了这里）——
      handleMove(ev) {
        if (!this.active || !this.overlay) return;
        if (!this.offsetReady) {
          this.geo.refreshThrottled();
          return;
        }
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
        const tx = Math.round(ev.clientX + this.offset.ox);
        const ty = Math.round(ev.clientY + this.offset.oy);
        this.showChip(ev.clientX, ev.clientY, `(${tx}, ${ty})`);
      }
      handleOut(ev) {
        if (!this.active) return;
        const rt = ev.relatedTarget;
        if (rt === null || rt instanceof Node && rt.ownerDocument !== document) {
          this.hoverEl = null;
          if (this.overlay) this.overlay.hover.style.display = "none";
          this.hideChip();
        }
      }
      handleClick(ev) {
        if (!this.active || !this.overlay) return;
        if (ev.button !== 0) return;
        const path = ev.composedPath();
        if (hitsDebugHost(path)) return;
        const el = deepestElement(path);
        if (!el || el === document.documentElement) return;
        ev.stopPropagation();
        const finalize = (chain, ox, oy) => {
          if (!this.active) return;
          const sel = {
            selector: "",
            tag: el.tagName.toLowerCase(),
            type: (el.getAttribute("type") || "").toLowerCase(),
            editable: isEditableEl(el),
            chain,
            clickX: Math.round(ev.clientX + ox),
            clickY: Math.round(ev.clientY + oy),
            sourceFrameId: 0
          };
          const bridge = getBridge();
          if (!bridge) {
            this.abortPick();
            return;
          }
          sel.selector = bridge.genSelector(el, el.ownerDocument);
          this.finishPick(sel, el);
        };
        if (this.forTop) {
          finalize([], 0, 0);
        } else {
          this.geo.probe().then((r) => {
            if (!this.active) return;
            if (!r.ok) {
              this.abortPick();
              return;
            }
            finalize(r.chain, r.ox, r.oy);
          }).catch(() => this.abortPick());
        }
      }
      handleKey(ev) {
        if (!this.active) return;
        if (ev.key === "Escape") {
          ev.stopPropagation();
          this.abortPick();
        }
      }
      // 点选收尾：停监听、保留选中框、回调（顶层：面板；子 frame：SW 上报）
      finishPick(sel, el) {
        const cb = this.onSelectCb;
        this.clearCallbacks();
        this.stopPicking();
        this.adoptRing(el);
        cb?.(sel, el);
      }
      // 取消选择（Esc 或跨域探测失败）：通知上层（顶层取消会话；子 frame 上报 SW 转发给面板）
      abortPick() {
        const esc = this.onEscCb;
        this.clearCallbacks();
        this.stopPicking();
        esc?.();
      }
      // —— 选中框（ring）保持：选中后由本帧持续跟随元素，直到新会话/面板关闭 ——
      adoptRing(el) {
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
      clearRing() {
        this.ringTarget = null;
        if (this.ringTimer) {
          window.clearInterval(this.ringTimer);
          this.ringTimer = 0;
        }
        if (this.overlay) this.overlay.sel.style.display = "none";
      }
      placeRing(ring, el) {
        const r = el.getBoundingClientRect();
        const pad = 2;
        ring.style.left = `${r.left - pad}px`;
        ring.style.top = `${r.top - pad}px`;
        ring.style.width = `${r.width + pad * 2}px`;
        ring.style.height = `${r.height + pad * 2}px`;
        ring.style.display = "block";
      }
      repositionAll() {
        if (!this.overlay) return;
        if (this.active && this.hoverEl && this.hoverEl.isConnected) {
          this.placeRing(this.overlay.hover, this.hoverEl);
        }
        if (this.ringTarget && this.ringTarget.isConnected) {
          this.placeRing(this.overlay.sel, this.ringTarget);
        }
        if (this.active && !this.forTop) this.geo.refreshThrottled();
      }
      showChip(clientX, clientY, label) {
        const chip = this.overlay.chip;
        chip.textContent = label;
        const pad = 10;
        const w = chip.offsetWidth;
        const h = chip.offsetHeight;
        let left = clientX + 14;
        let top = clientY + 20;
        const vw = window.innerWidth - (this.forTop ? PANEL_W + pad : 0);
        const vh = window.innerHeight;
        if (left + w + pad > vw) left = Math.max(pad, clientX - w - 12);
        if (top + h + pad > vh) top = Math.max(pad, clientY - h - 8);
        chip.style.left = `${left}px`;
        chip.style.top = `${top}px`;
        chip.style.display = "block";
      }
      hideChip() {
        if (this.overlay) this.overlay.chip.style.display = "none";
      }
    }
    function deepestElement(path) {
      for (const n of path) {
        if (n instanceof Element) return n;
      }
      return null;
    }
    const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; }
.panel {
  position: fixed; top: 0; right: 0; bottom: 0; width: ${PANEL_W}px; z-index: 2147483647;
  display: flex; flex-direction: column; background: #fff; color: #202124;
  border-left: 1px solid #dadce0; box-shadow: -4px 0 16px rgba(0, 0, 0, 0.12);
  font-size: 13px; line-height: 1.5;
  /* \u5BBF\u4E3B\u662F pointer-events:none\uFF08\u4E0D\u6321 hit-test\uFF09\uFF0C\u9762\u677F\u672C\u4F53\u5FC5\u987B\u91CD\u65B0\u53EF\u547D\u4E2D\uFF1A
     auto \u6CBF\u5B50\u6811\u7EE7\u627F\uFF0C\u9762\u677F\u533A\u6574\u4F53\u62E6\u622A\u70B9\u51FB\uFF08\u9875\u9762\u6536\u4E0D\u5230\u9762\u677F\u533A\u57DF\u4E0B\u7684\u70B9\u51FB\uFF09 */
  pointer-events: auto;
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
    const ACTIONS = [
      { id: "click", label: "\u70B9\u51FB", group: "common", needsLocatable: true },
      { id: "real_click", label: "\u771F\u5B9E\u70B9\u51FB", group: "common", needsLocatable: true },
      { id: "scrollTo", label: "\u6EDA\u5230\u5143\u7D20", group: "common", needsLocatable: true },
      { id: "type", label: "\u8F93\u5165\u6587\u5B57", group: "edit", needsLocatable: true, params: [{ key: "text", label: "\u6587\u5B57", placeholder: "\u8981\u8F93\u5165\u7684\u5185\u5BB9\u2026" }] },
      { id: "key", label: "\u6309\u952E", group: "edit", needsLocatable: true, params: [{ key: "key", label: "\u6309\u952E", def: "Enter", placeholder: "\u5982 Enter / Tab / a" }] },
      { id: "trigger", label: "\u89E6\u53D1\u4E8B\u4EF6", group: "edit", needsLocatable: true, params: [{ key: "event", label: "\u4E8B\u4EF6", def: "change", placeholder: "change / blur / input" }] },
      { id: "upload_file", label: "\u9009\u62E9\u6587\u4EF6\u4E0A\u4F20", group: "file", needsLocatable: true, file: true },
      { id: "upload_drop", label: "\u62D6\u62FD\u4E0A\u4F20", group: "drop", needsLocatable: true, file: true },
      { id: "get_text", label: "\u8BFB\u53D6\u6587\u672C", group: "common", needsLocatable: true },
      { id: "get_css", label: "\u8BFB\u53D6\u6837\u5F0F", group: "common", needsLocatable: true },
      { id: "get_prop", label: "\u8BFB\u53D6\u5C5E\u6027", group: "common", needsLocatable: true, params: [{ key: "prop", label: "\u5C5E\u6027", def: "value", placeholder: "\u5982 value / checked / href" }] },
      { id: "show", label: "\u5F3A\u5236\u663E\u793A", group: "common", needsLocatable: true }
    ];
    class DebugPanel {
      constructor(onClose, onPickAgain, runInFrame, broadcast, realClick) {
        this.onClose = onClose;
        this.onPickAgain = onPickAgain;
        this.runInFrame = runInFrame;
        this.broadcast = broadcast;
        this.realClick = realClick;
        this.el = {};
        this.sel = null;
        this.locatable = false;
        this.results = [];
        this.executing = false;
        this.picking = false;
        this.copyTimer = 0;
        this.busySeq = 0;
        this.destroyed = false;
        this.host = document.createElement("div");
        this.host.setAttribute("data-cda-debug-host", "1");
        this.host.style.cssText = `all:initial;position:fixed;top:0;right:0;bottom:0;width:${PANEL_W}px;z-index:2147483647;pointer-events:none;`;
        this.root = this.host.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        style.textContent = PANEL_CSS;
        this.root.appendChild(style);
        this.root.appendChild(this.buildDom());
        (document.body || document.documentElement).appendChild(this.host);
        this.fileInput = document.createElement("input");
        this.fileInput.type = "file";
        this.fileInput.style.display = "none";
        this.root.appendChild(this.fileInput);
        this.root.addEventListener("click", (ev) => {
          const target = ev.target;
          const x = target.closest?.(".x");
          if (x) {
            this.onClose();
            return;
          }
          const btn = target.closest?.(".pick-again");
          if (btn) {
            this.onPickAgain();
            return;
          }
          const act = target.closest?.("[data-act]");
          if (act) {
            const id = act.getAttribute("data-act");
            this.runAction(id);
            return;
          }
        });
        this.fileInput.addEventListener("change", () => {
          const pending = this.fileInput._cdaCmd;
          const file = this.fileInput.files?.[0];
          this.fileInput.value = "";
          if (!pending || !file) return;
          this.execFileAction(pending, file);
        });
      }
      buildDom() {
        const wrap = document.createElement("div");
        wrap.className = "panel";
        wrap.innerHTML = `
      <div class="head">
        <div class="t">\u8C03\u8BD5\u6A21\u5F0F <span class="k">(\u2318]/Ctrl+] \u5F00\u5173)</span></div>
        <button class="x" title="\u5173\u95ED\uFF08\u2318+]/Ctrl+]\uFF09">\xD7</button>
      </div>
      <div class="status">\u51C6\u5907\u4E2D\u2026</div>
      <div class="pickbar">
        <button class="pick-again">\u91CD\u65B0\u9009\u62E9\u5143\u7D20</button>
      </div>
      <div class="body">
        <div class="hint" data-part="pickHint">
          \u70B9\u51FB\u9875\u9762\u5143\u7D20\u5373\u53EF\u9009\u4E2D\uFF08\u652F\u6301 iframe \u5185\u4E0E shadow DOM \u5185\u5143\u7D20\uFF1B\u8DE8\u57DF iframe \u5185\u90E8\u4E0D\u652F\u6301\uFF1B\u60AC\u505C\u6709\u5750\u6807\u9884\u89C8\uFF0C\u70B9\u51FB\u8BB0\u5F55\u9009\u4E2D\u5750\u6807\uFF09\u3002
        </div>
        <div data-part="selection" style="display:none"></div>
        <div data-part="actions" style="display:none"></div>
        <div class="results" data-part="results"></div>
      </div>`;
        const map = (part) => wrap.querySelector(`[data-part="${part}"]`);
        this.el.selection = map("selection");
        this.el.actions = map("actions");
        this.el.results = map("results");
        this.el.pickHint = map("pickHint");
        this.el.pickBtn = wrap.querySelector(".pick-again");
        const status = wrap.querySelector(".status");
        this.el.status = status;
        const actions = document.createElement("div");
        const groups = [
          { id: "common", title: "\u901A\u7528\u64CD\u4F5C" },
          { id: "edit", title: "\u8F93\u5165\u64CD\u4F5C" },
          { id: "file", title: "\u6587\u4EF6\u4E0A\u4F20" },
          { id: "drop", title: "\u62D6\u62FD\u4E0A\u4F20" },
          { id: "global", title: "\u5168\u5C40" }
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
            btn.textContent = "\u8FD8\u539F\u9875\u9762\u663E\u793A (hide)";
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
      enterPicking() {
        this.picking = true;
        this.sel = null;
        this.locatable = false;
        this.setStatus("\u9009\u62E9\u6A21\u5F0F\uFF1A\u70B9\u51FB\u9875\u9762\u5143\u7D20\u9009\u4E2D\uFF08Esc \u53D6\u6D88\uFF09", true);
        this.el.pickHint.style.display = "";
        this.el.selection.style.display = "none";
        this.el.actions.style.display = "none";
        if (this.el.pickBtn) this.el.pickBtn.disabled = true;
      }
      exitPickNoSelect() {
        this.picking = false;
        this.setStatus("\u5DF2\u53D6\u6D88\u9009\u62E9\uFF0C\u672A\u9009\u4E2D\u5143\u7D20\u3002\u70B9\u300C\u91CD\u65B0\u9009\u62E9\u5143\u7D20\u300D\u7EE7\u7EED\u3002", false);
        this.el.pickHint.style.display = "";
        if (this.el.pickBtn) this.el.pickBtn.disabled = false;
      }
      applySelection(sel, locatable) {
        this.picking = false;
        this.sel = sel;
        this.locatable = locatable;
        this.setStatus("\u5DF2\u9009\u4E2D\u5143\u7D20\uFF0C\u9009\u62E9\u4E0B\u65B9\u52A8\u4F5C\u6267\u884C", false);
        this.el.pickHint.style.display = "none";
        if (this.el.pickBtn) this.el.pickBtn.disabled = false;
        this.renderSelection();
        this.renderActions();
      }
      setStatus(text, picking) {
        this.el.status.textContent = text;
        this.el.status.className = picking ? "status picking" : "status";
      }
      renderSelection() {
        const s = this.sel;
        const box = document.createElement("div");
        box.className = "sel-box";
        const meta = document.createElement("div");
        meta.className = "sel-meta";
        const where = s.chain.length === 0 ? "\u9876\u5C42\u9875\u9762" : `iframe \u5185\u5143\u7D20\uFF08${s.chain.length} \u5C42\uFF09`;
        meta.innerHTML = "";
        const add = (k, v) => {
          const span = document.createElement("span");
          const b = document.createElement("b");
          b.textContent = v;
          span.append(`${k} `, b);
          meta.appendChild(span);
        };
        add("\u5143\u7D20", `<${s.tag}>`);
        if (s.type) add("type", s.type);
        add("\u4F4D\u7F6E", where);
        add("\u70B9\u51FB\u5750\u6807", `(${s.clickX}, ${s.clickY})`);
        box.appendChild(meta);
        const ta = document.createElement("textarea");
        ta.value = s.selector;
        ta.readOnly = true;
        ta.title = "\u5B8C\u6574 CSS \u9009\u62E9\u5668\uFF08\u542B shadow \u7A7F\u900F >>> \u6BB5\uFF09";
        box.appendChild(ta);
        const row = document.createElement("div");
        row.className = "sel-actions";
        const copyBtn = document.createElement("button");
        copyBtn.className = "copy-btn";
        copyBtn.textContent = "\u590D\u5236\u9009\u62E9\u5668";
        const copyState = document.createElement("span");
        copyState.className = "copy-state";
        copyState.style.display = "none";
        const flash = () => {
          copyState.textContent = "\u5DF2\u590D\u5236";
          copyState.style.display = "";
          window.clearTimeout(this.copyTimer);
          this.copyTimer = window.setTimeout(() => copyState.style.display = "none", 1500);
        };
        copyBtn.addEventListener("click", () => {
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(s.selector).then(flash).catch(() => {
              ta.select();
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
          warn.textContent = "\u8BE5\u5143\u7D20\u5F53\u524D\u65E0\u6CD5\u7528\u9009\u62E9\u5668\u4E8C\u6B21\u5B9A\u4F4D\uFF08closed shadow \u5185\u90E8\u6216\u9875\u9762\u5DF2\u53D8\u5316\uFF09\u2014\u2014\u4E0A\u65B9\u52A8\u4F5C\u5DF2\u7F6E\u7070\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u3002";
          box.appendChild(warn);
        }
        this.el.selection.replaceChildren(box);
        this.el.selection.style.display = "";
      }
      renderActions() {
        const s = this.sel;
        this.el.actions.style.display = s ? "" : "none";
        if (!s) return;
        const isFile = s.tag === "input" && s.type === "file";
        const avail = (a) => {
          if (!this.locatable && a.needsLocatable) return false;
          switch (a.group) {
            case "common":
              return true;
            case "edit":
              return s.editable;
            case "file":
              return isFile;
            case "drop":
              return !isFile;
            default:
              return true;
          }
        };
        for (const btn of this.el.actions.querySelectorAll("[data-act]")) {
          const def = ACTIONS.find((a) => a.id === btn.getAttribute("data-act"));
          const available = def ? avail(def) : btn.getAttribute("data-act") === "hide";
          btn.disabled = !available || this.executing;
        }
      }
      // ========== 动作执行 ==========
      runAction(id) {
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
      execActionNoParams(id) {
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
      pickFile(actionId) {
        const input = this.fileInput;
        input._cdaCmd = actionId;
        try {
          input.click();
        } catch {
          this.addResult(actionId, false, "\u65E0\u6CD5\u6253\u5F00\u6587\u4EF6\u9009\u62E9\u5668");
        }
      }
      execFileAction(actionId, file) {
        const s = this.sel;
        if (!s) return;
        const reader = new FileReader();
        reader.onerror = () => this.addResult(actionId, false, "\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25");
        reader.onload = () => {
          const dataUrl = reader.result;
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
      openParamRow(def) {
        if (!this.sel || !def.params) return;
        const existing = this.el.actions.querySelector(".param-row");
        if (existing) existing.remove();
        const row = document.createElement("div");
        row.className = "param-row";
        const values = {};
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
        okBtn.textContent = "\u6267\u884C";
        okBtn.addEventListener("click", () => {
          const params = {};
          for (const p of def.params) {
            const v = values[p.key].value;
            params[p.key] = p.def && v === "" ? p.def : v;
          }
          row.remove();
          this.execParamsAction(def.id, params);
        });
        const cancel = document.createElement("button");
        cancel.className = "act";
        cancel.textContent = "\u53D6\u6D88";
        cancel.addEventListener("click", () => row.remove());
        row.append(okBtn, cancel);
        for (const input of Object.values(values)) {
          input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") okBtn.click();
            if (ev.key === "Escape") row.remove();
          });
        }
        this.el.actions.appendChild(row);
        const first = Object.values(values)[0];
        if (first) first.focus();
      }
      execParamsAction(id, params) {
        const s = this.sel;
        if (!s) return;
        const base = { selector: s.selector };
        switch (id) {
          case "type": {
            const text = String(params.text ?? "");
            if (!text) {
              this.addResult("type", false, "\u8BF7\u8F93\u5165\u8981\u8F93\u5165\u7684\u6587\u5B57");
              return;
            }
            this.exec(this.runInFrame("type", { ...base, text, mode: "replace" }, s.chain), "type");
            break;
          }
          case "key":
            this.exec(this.runInFrame("keyboard", { ...base, key: String(params.key ?? "Enter") }, s.chain), "keyboard");
            break;
          case "trigger": {
            const p = { ...base, event: String(params.event ?? "change") };
            const value = params.value;
            if (value !== "" && value !== void 0) p.value = value;
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
      execRealClick() {
        const s = this.sel;
        this.setBusy("\u6B63\u5728\u8BA1\u7B97\u771F\u5B9E\u70B9\u51FB\u5750\u6807\uFF08\u6EDA\u52A8\u5230\u5143\u7D20\uFF09\u2026");
        this.runInFrame("get_rect", { selector: s.selector, scroll: true }, s.chain).then((rect) => {
          if (!rect.success || typeof rect.data !== "object" || rect.data === null) {
            this.addResult("real_click", false, String(rect.error ?? "\u65E0\u6CD5\u5B9A\u4F4D\u5143\u7D20\u5750\u6807"));
            this.setBusy(null);
            return;
          }
          const d = rect.data;
          if (typeof d.x !== "number" || typeof d.y !== "number") {
            this.addResult("real_click", false, "\u5B9A\u4F4D\u54CD\u5E94\u7F3A\u5C11\u5750\u6807");
            this.setBusy(null);
            return;
          }
          if (d.x < 0 || d.y < 0 || d.x > window.innerWidth || d.y > window.innerHeight) {
            this.addResult("real_click", false, `\u76EE\u6807\u4F4D\u4E8E\u53EF\u89C6\u533A\u5916 (${d.x}, ${d.y})\u2014\u2014\u5916\u5C42 iframe \u53EF\u80FD\u5DF2\u6EDA\u51FA\u9875\u9762\uFF0C\u771F\u5B9E\u70B9\u51FB\u4F1A\u843D\u7A7A\u3002\u8BF7\u6EDA\u52A8\u9875\u9762\u540E\u91CD\u8BD5\u3002`);
            this.setBusy(null);
            return;
          }
          this.host.style.visibility = "hidden";
          this.busySeq++;
          const seq = this.busySeq;
          const fire = () => {
            this.realClick(d.x, d.y, s.chain).then((r) => {
              if (seq !== this.busySeq) return;
              this.host.style.visibility = "visible";
              this.addResult(
                "real_click",
                r.success,
                r.success ? `(${d.x}, ${d.y}) trusted \u70B9\u51FB\u5B8C\u6210
${stringifyData(r.data ?? {})}` : String(r.error ?? "\u771F\u5B9E\u70B9\u51FB\u5931\u8D25")
              );
              this.setBusy(null);
            }).catch((err) => {
              if (seq !== this.busySeq) return;
              this.host.style.visibility = "visible";
              this.addResult("real_click", false, `\u771F\u5B9E\u70B9\u51FB\u5F02\u5E38: ${err instanceof Error ? err.message : String(err)}`);
              this.setBusy(null);
            });
          };
          requestAnimationFrame(() => requestAnimationFrame(fire));
        }).catch((err) => {
          this.addResult("real_click", false, `\u5750\u6807\u8BA1\u7B97\u5F02\u5E38: ${err instanceof Error ? err.message : String(err)}`);
          this.setBusy(null);
        });
      }
      exec(p, cmdLabel) {
        this.setBusy(`\u6B63\u5728\u6267\u884C ${cmdLabel} \u2026`);
        p.then((r) => {
          if (r.success) {
            this.addResult(cmdLabel, true, stringifyData(r.data ?? { ok: true }));
          } else {
            this.addResult(cmdLabel, false, String(r.error ?? "\u672A\u77E5\u9519\u8BEF"));
          }
          this.setBusy(null);
        }).catch((err) => {
          this.addResult(cmdLabel, false, `\u6267\u884C\u5F02\u5E38: ${err instanceof Error ? err.message : String(err)}`);
          this.setBusy(null);
        });
      }
      setBusy(text) {
        this.executing = text != null;
        this.renderActions();
        const div = this.el.actions.querySelector(".busy");
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
      addResult(cmd, ok, text) {
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
        badge.textContent = ok ? "\u6210\u529F" : "\u5931\u8D25";
        head.appendChild(badge);
        const body = document.createElement("div");
        body.className = "res-body";
        body.textContent = text;
        row.append(head, body);
        const resultsBox = this.el.results;
        resultsBox.appendChild(row);
        resultsBox.scrollTop = resultsBox.scrollHeight;
      }
      destroy() {
        this.destroyed = true;
        if (this.fileInput) this.fileInput.remove();
        this.host.remove();
      }
    }
    class DebugController {
      // 可定位性探测序号：探测返回时若已进入新会话/新选择则丢弃
      constructor() {
        this.panel = null;
        this.picker = null;
        this.session = "closed";
        this.pendingProbe = 0;
        this.picker = new FramePicker(true);
      }
      toggle() {
        if (this.panel) {
          this.closePanel();
        } else {
          this.openPanel();
        }
      }
      openPanel() {
        this.panel = new DebugPanel(
          () => this.closePanel(),
          () => this.enterPicking(),
          (command, params, chain) => this.runCommand(command, params, chain),
          (command) => this.runBroadcast(command),
          (x, y, chain) => this.runRealClick(x, y, chain)
        );
        this.enterPicking();
      }
      closePanel() {
        if (!this.panel) return;
        this.leavePicking();
        this.panel.destroy();
        this.panel = null;
        this.broadcastState("closed");
      }
      leavePicking() {
        this.pendingProbe++;
        this.session = "closed";
        this.picker.dispose();
        setIntercept(false, false);
      }
      enterPicking() {
        if (!this.panel) return;
        if (this.session !== "picking") {
          this.pendingProbe++;
          this.session = "picking";
          this.picker.startPicking((sel) => this.onLocalPick(sel), () => this.cancelPicking());
          setIntercept(true, true);
          this.broadcastState("picking");
        }
        this.panel.enterPicking();
      }
      cancelPicking() {
        if (!this.panel || this.session !== "picking") return;
        this.pendingProbe++;
        this.session = "idle";
        this.picker.stopPicking();
        setIntercept(false, true);
        this.panel.exitPickNoSelect();
        this.broadcastState("idle");
      }
      onLocalPick(sel) {
        sel.sourceFrameId = 0;
        this.onPick(sel);
      }
      // 子 frame 上报的选择/Esc（SW 按 tabId 转发到顶层帧，sourceFrameId 标记来源帧）
      onRemotePick(payload, sourceFrameId) {
        if (!payload) return;
        payload.sourceFrameId = typeof sourceFrameId === "number" ? sourceFrameId : 0;
        this.onPick(payload);
      }
      onPick(sel) {
        if (!this.panel || this.session !== "picking") return;
        this.pendingProbe++;
        this.session = "idle";
        this.picker.stopPicking();
        setIntercept(false, true);
        this.broadcastState("idle");
        this.panel.applySelection(sel, false);
        const seq = this.pendingProbe;
        this.probeLocatable(sel.chain, sel.selector).then((ok) => {
          if (seq !== this.pendingProbe || !this.panel || this.panel.destroyed) return;
          if (ok) this.panel.applySelection(sel, true);
        }).catch(() => {
        });
      }
      onEscFromChild() {
        if (this.session === "picking") this.cancelPicking();
      }
      // 面板操作路由：选中元素可能在子 frame —— 顶层走本地桥，其余经 SW 逐跳解析执行
      runCommand(command, params, chain) {
        if (chain.length === 0) {
          const bridge = getBridge();
          if (!bridge) return Promise.resolve({ success: false, error: "content script \u6865\u4E0D\u53EF\u7528" });
          return bridge.handleCommand({ command, params });
        }
        return chrome.runtime.sendMessage({ type: "debug_execute", payload: { command, params, chain } }).then((r) => r ?? { success: false, error: "service worker \u672A\u54CD\u5E94" }).catch((err) => ({ success: false, error: `debug_execute \u5931\u8D25: ${err instanceof Error ? err.message : String(err)}` }));
      }
      runBroadcast(command) {
        return chrome.runtime.sendMessage({ type: "debug_broadcast", payload: { command } }).then((r) => r ?? { success: false, error: "service worker \u672A\u54CD\u5E94" }).catch((err) => ({ success: false, error: `debug_broadcast \u5931\u8D25: ${err instanceof Error ? err.message : String(err)}` }));
      }
      runRealClick(x, y, chain) {
        return chrome.runtime.sendMessage({ type: "debug_real_click", payload: { x, y, chain } }).then((r) => r ?? { success: false, error: "service worker \u672A\u54CD\u5E94" }).catch((err) => ({ success: false, error: `debug_real_click \u5931\u8D25: ${err instanceof Error ? err.message : String(err)}` }));
      }
      probeLocatable(chain, selector) {
        if (!selector) return Promise.resolve(false);
        return this.runCommand("get_rect", { selector }, chain).then((r) => r.success === true && !r.notFound).catch(() => false);
      }
      broadcastState(state) {
        chrome.runtime.sendMessage({ type: "debug_mode", payload: { state } }).catch(() => {
        });
      }
    }
    class ChildSession {
      constructor() {
        this.picker = null;
        this.picking = false;
        this.picker = new FramePicker(false);
      }
      startPicking() {
        if (this.picking) return;
        this.picking = true;
        this.picker.startPicking((sel) => this.report(sel), () => this.reportEsc());
      }
      stopPicking() {
        this.picking = false;
        this.picker.stopPicking();
      }
      dispose() {
        this.picking = false;
        this.picker.dispose();
      }
      report(sel) {
        chrome.runtime.sendMessage({ type: "debug_pick_selected", payload: sel }).catch(() => {
        });
      }
      reportEsc() {
        chrome.runtime.sendMessage({ type: "debug_pick_esc", payload: {} }).catch(() => {
        });
      }
    }
    const controller = IS_TOP ? new DebugController() : null;
    const childSession = IS_TOP ? null : new ChildSession();
    function applySession(state) {
      if (IS_TOP) return;
      const cs = childSession;
      if (!cs) return;
      if (state === "picking") cs.startPicking();
      else if (state === "idle") cs.stopPicking();
      else if (state === "closed") cs.dispose();
    }
    chrome.runtime.onMessage.addListener(
      (msg, _sender, sendResponse) => {
        if (!msg || typeof msg.type !== "string") return;
        try {
          if (msg.type === "debug_mode") {
            const state = msg.payload?.state ?? "";
            applySession(state);
            sendResponse?.({ ok: true });
            return true;
          }
          if (IS_TOP && msg.type === "debug_pick_selected") {
            controller?.onRemotePick(msg.payload, msg.sourceFrameId);
            sendResponse?.({ ok: true });
            return true;
          }
          if (IS_TOP && msg.type === "debug_pick_esc") {
            controller?.onEscFromChild();
            sendResponse?.({ ok: true });
            return true;
          }
        } catch {
        }
        return;
      }
    );
    if (IS_TOP && controller) {
      document.addEventListener(TOGGLE_EVT, (ev) => {
        try {
          const detail = ev.detail;
          if (detail?.viaChild) return;
          controller.toggle();
        } catch {
        }
      });
    }
  })();
})();
