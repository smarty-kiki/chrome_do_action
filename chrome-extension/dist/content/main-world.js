"use strict";
(() => {
  // src/content/main-world.ts
  var EVT = "__cda_js_error__";
  var SYNC_EVT = "__cda_js_error_sync__";
  var MAX = 200;
  var buffer = [];
  var synced = false;
  function emit(e) {
    try {
      document.dispatchEvent(new CustomEvent(EVT, { detail: e }));
    } catch {
    }
  }
  function record(e) {
    if (!synced) {
      buffer.push(e);
      if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
    }
    emit(e);
  }
  var inHandler = false;
  function safeRun(fn) {
    if (inHandler) return;
    inHandler = true;
    try {
      fn();
    } catch {
    } finally {
      inHandler = false;
    }
  }
  window.addEventListener(
    "error",
    (ev) => {
      safeRun(() => {
        if (!(ev instanceof ErrorEvent)) return;
        record({ message: ev.message, source: ev.filename, lineno: ev.lineno, colno: ev.colno });
      });
    },
    true
  );
  window.addEventListener("unhandledrejection", (ev) => {
    safeRun(() => {
      const reason = ev.reason;
      const msg = typeof reason === "string" ? reason : (reason && reason.message) ?? String(reason);
      record({ message: `Unhandled rejection: ${msg}`, source: "unhandledrejection" });
    });
  });
  document.addEventListener(SYNC_EVT, () => {
    safeRun(() => {
      if (synced) return;
      synced = true;
      const pending = buffer.splice(0, buffer.length);
      for (const e of pending) emit(e);
    });
  });
  (() => {
    const TOGGLE_EVT = "__cda_debug_toggle__";
    const INTERCEPT_EVT = "__cda_debug_intercept__";
    const GEO_EVT = "__cda_debug_geo__";
    const GEO_REPLY_EVT = "__cda_debug_geo_reply__";
    const PICK_EVT = "__cda_debug_pick__";
    const ESC_EVT = "__cda_debug_esc__";
    let interceptState = { picking: false, iso: false };
    const isToggleKey = (e) => e.code === "BracketRight" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.repeat;
    window.addEventListener(
      "keydown",
      (ev) => {
        safeRun(() => {
          if (!isToggleKey(ev)) return;
          ev.stopImmediatePropagation();
          ev.preventDefault();
          const evt = () => document.dispatchEvent(new CustomEvent(TOGGLE_EVT));
          const top = window.top;
          if (top === null || top === window) {
            evt();
          } else {
            try {
              top.document.dispatchEvent(new CustomEvent(TOGGLE_EVT, { detail: { viaChild: true } }));
            } catch {
            }
          }
        });
      },
      true
    );
    document.addEventListener(TOGGLE_EVT, (ev) => {
      safeRun(() => {
        const detail = ev.detail;
        if (!detail || !detail.viaChild) return;
        document.dispatchEvent(new CustomEvent(TOGGLE_EVT));
      });
    });
    const POINTER_TYPES = [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
      "auxclick",
      "dblclick",
      "contextmenu"
    ];
    const hitsHost = (ev) => ev.composedPath().some((n) => n instanceof Element && n.hasAttribute("data-cda-debug-host"));
    const relayDebug = (type, detail) => {
      try {
        document.dispatchEvent(new CustomEvent(type, { detail }));
      } catch {
      }
    };
    const pointerGuard = (ev) => {
      if (!interceptState.picking) return;
      if (hitsHost(ev)) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      if (ev.type === "click") {
        const me = ev;
        relayDebug(PICK_EVT, { x: me.clientX, y: me.clientY });
      }
    };
    for (const type of POINTER_TYPES) {
      window.addEventListener(type, (ev) => safeRun(() => pointerGuard(ev)), true);
    }
    const keyGuard = (ev) => {
      if (!(interceptState.picking || interceptState.iso)) return;
      if (ev.key !== "Escape" || ev.repeat) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      if (ev.type === "keydown") relayDebug(ESC_EVT, { host: hitsHost(ev) });
    };
    window.addEventListener("keydown", (ev) => safeRun(() => keyGuard(ev)), true);
    window.addEventListener("keyup", (ev) => safeRun(() => keyGuard(ev)), true);
    const MAIN_MSG = "__cdaMain";
    const applyIntercept = (detail) => {
      const d = detail;
      if (!d) return;
      interceptState = { picking: !!d.picking, iso: !!d.iso };
    };
    const applyGeoRequest = (reqDetail) => {
      const req = reqDetail;
      if (!req || typeof req.requestId !== "number") return;
      const reply = (detail) => {
        const payload = { requestId: req.requestId, ...detail };
        document.dispatchEvent(new CustomEvent(GEO_REPLY_EVT, { detail: payload }));
        try {
          window.postMessage({ [MAIN_MSG]: GEO_REPLY_EVT, detail: payload }, "*");
        } catch {
        }
      };
      const hops = [];
      let ox = 0;
      let oy = 0;
      let w = window;
      let blocked = false;
      try {
        while (w !== window.top) {
          const fe = w.frameElement;
          if (!fe) {
            blocked = true;
            break;
          }
          const rect = fe.getBoundingClientRect();
          const doc = fe.ownerDocument;
          const frames = doc.querySelectorAll("iframe");
          let index = -1;
          for (let i = 0; i < frames.length; i++) {
            if (frames[i] === fe) {
              index = i;
              break;
            }
          }
          if (index < 0) {
            blocked = true;
            break;
          }
          hops.unshift({ index, url: w.location.href });
          ox += rect.left;
          oy += rect.top;
          w = w.parent;
        }
      } catch {
        blocked = true;
      }
      if (blocked) {
        reply({ ok: false, crossOrigin: true });
      } else {
        reply({ ok: true, chain: hops, ox: Math.round(ox), oy: Math.round(oy) });
      }
    };
    document.addEventListener(INTERCEPT_EVT, (ev) => safeRun(() => applyIntercept(ev.detail)));
    document.addEventListener(GEO_EVT, (ev) => safeRun(() => applyGeoRequest(ev.detail)));
    window.addEventListener("message", (ev) => {
      safeRun(() => {
        const data = ev.data;
        if (!data || typeof data !== "object" || typeof data[MAIN_MSG] !== "string") return;
        if (data[MAIN_MSG] === INTERCEPT_EVT) applyIntercept(data.detail);
        else if (data[MAIN_MSG] === GEO_EVT) applyGeoRequest(data.detail);
      });
    });
  })();
  (() => {
    const MAIN_MSG = "__cdaMain";
    const ACTION_EVT = "__cda_main_action__";
    const ACTION_REPLY_EVT = "__cda_main_action_reply__";
    const seenReq = [];
    const reqSeen = (id) => {
      if (seenReq.indexOf(id) >= 0) return true;
      seenReq.push(id);
      if (seenReq.length > 32) seenReq.shift();
      return false;
    };
    const replyAction = (requestId, action, detail) => {
      const payload = { requestId, action, ...detail };
      try {
        document.dispatchEvent(new CustomEvent(ACTION_REPLY_EVT, { detail: payload }));
      } catch {
      }
      try {
        window.postMessage({ [MAIN_MSG]: ACTION_REPLY_EVT, detail: payload }, "*");
      } catch {
      }
    };
    const toPlainText = (markup) => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:-9999px;top:0";
      probe.innerHTML = markup;
      document.body.appendChild(probe);
      const text = probe.innerText;
      probe.remove();
      return text;
    };
    const findPasteHost = () => {
      const sel = document.getSelection();
      let node = sel && sel.anchorNode ? sel.anchorNode : null;
      if (node && node.nodeType !== 1) node = node.parentElement;
      while (node && node.nodeType === 1) {
        const el = node;
        if (el.isContentEditable) return el;
        node = el.parentElement;
      }
      return null;
    };
    const applyPasteRequest = (req) => {
      if (typeof req.html !== "string") {
        replyAction(req.requestId, "paste_dispatch", { ok: false, error: 'Need "html" parameter (a string)' });
        return;
      }
      const host = findPasteHost();
      if (!host) {
        replyAction(req.requestId, "paste_dispatch", { ok: false, error: "\u5149\u6807\u4E0D\u5728\u53EF\u7F16\u8F91\u533A\uFF08\u627E\u4E0D\u5230 contenteditable \u5BBF\u4E3B\uFF09" });
        return;
      }
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", toPlainText(req.html));
        dt.setData("text/html", req.html);
        const pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(pasteEvt, "clipboardData", { value: dt });
        host.dispatchEvent(pasteEvt);
        replyAction(req.requestId, "paste_dispatch", { ok: true, defaultPrevented: pasteEvt.defaultPrevented });
      } catch (e) {
        replyAction(req.requestId, "paste_dispatch", { ok: false, error: e.message });
      }
    };
    const POSITIONS = ["before", "after", "start", "end"];
    const shadowRootsDeep = (root = document) => {
      const out = [];
      const walk = (r) => {
        if (r instanceof Element && r.shadowRoot) {
          out.push(r.shadowRoot);
          walk(r.shadowRoot);
        }
        for (const el of Array.from(r.querySelectorAll("*"))) {
          const sr = el.shadowRoot;
          if (sr) {
            out.push(sr);
            walk(sr);
          }
        }
      };
      walk(root);
      return out;
    };
    const resolveRoot = (selector) => {
      if (selector.startsWith("xpath:")) {
        const exp = selector.slice(6);
        try {
          const hit = document.evaluate(exp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          if (hit) return hit;
        } catch {
        }
        for (const sr of shadowRootsDeep()) {
          for (const child of Array.from(sr.children)) {
            try {
              const hit = document.evaluate(exp, child, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
              if (hit) return hit;
            } catch {
            }
          }
        }
        return null;
      }
      const css = selector.startsWith("css:") ? selector.slice(4) : selector;
      try {
        const direct = document.querySelector(css);
        if (direct) return direct;
      } catch {
      }
      for (const sr of shadowRootsDeep()) {
        try {
          const el = sr.querySelector(css);
          if (el) return el;
        } catch {
        }
      }
      return null;
    };
    const excludedFromRow = (node, row) => {
      let cur = node.nodeType === 1 ? node : node.parentElement;
      while (cur && cur !== row) {
        const tag = cur.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return true;
        if (cur.getAttribute("contenteditable") === "false") return true;
        try {
          if (getComputedStyle(cur).display === "none") return true;
        } catch {
        }
        cur = cur.parentElement;
      }
      return false;
    };
    const rowQualified = (el) => {
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return false;
      if (el.getAttribute("contenteditable") === "false") return false;
      try {
        if (getComputedStyle(el).display === "none") return false;
      } catch {
      }
      return true;
    };
    const buildRows = (root) => {
      for (const n of Array.from(root.childNodes)) {
        if (n.nodeType === 3 && n.data.length > 0) return [root];
      }
      const rows = [];
      for (const el of Array.from(root.children)) {
        if (rowQualified(el)) rows.push(el);
      }
      return rows.length > 0 ? rows : [root];
    };
    const modelOf = (root) => {
      return buildRows(root).map((el) => {
        const runs = [];
        let pos = 0;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while (n = walker.nextNode()) {
          const t = n;
          if (t.data.length === 0 || excludedFromRow(t, el)) continue;
          runs.push({ node: t, start: pos, end: pos + t.data.length });
          pos += t.data.length;
        }
        return { el, runs, text: runs.map((r) => r.node.data).join("") };
      });
    };
    const rowLen = (m) => m.runs.length === 0 ? 0 : m.runs[m.runs.length - 1].end;
    const findText = (model, needle, occurrence) => {
      let seen = 0;
      for (let i = 0; i < model.length; i++) {
        const line = model[i].text;
        let from = 0;
        let idx = line.indexOf(needle, from);
        while (idx >= 0) {
          seen++;
          if (seen === occurrence) return { found: { rowIndex: i, colStart: idx, colEnd: idx + needle.length }, seen };
          from = idx + 1;
          idx = line.indexOf(needle, from);
        }
      }
      return { found: null, seen };
    };
    const cmpPos = (a, b) => {
      if (a.node === b.node) return a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0;
      const aEl = a.node.nodeType === 1 ? a.node : null;
      const bEl = b.node.nodeType === 1 ? b.node : null;
      if (aEl && aEl.contains(b.node)) {
        let cur = b.node;
        while (cur.parentNode !== a.node) cur = cur.parentNode;
        const i = Array.prototype.indexOf.call(a.node.childNodes, cur);
        if (a.offset < i) return -1;
        if (a.offset > i) return 1;
        return cmpPos({ node: cur, offset: 0 }, b);
      }
      if (bEl && bEl.contains(a.node)) return -cmpPos(b, a);
      let p = a.node.parentNode;
      let aChild = a.node;
      while (p && !p.contains(b.node)) {
        aChild = p;
        p = p.parentNode;
      }
      if (!p) return 0;
      let q = b.node.parentNode;
      let bChild = b.node;
      while (q !== null && q !== p) {
        bChild = q;
        q = q.parentNode;
      }
      const ai = Array.prototype.indexOf.call(p.childNodes, aChild);
      const bi = Array.prototype.indexOf.call(p.childNodes, bChild);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    };
    const colAt = (runs, anchor, anchorOffset) => {
      if (runs.length === 0) return 0;
      if (anchor.nodeType === 3) {
        for (const run of runs) {
          if (run.node === anchor) {
            return run.start + Math.min(Math.max(anchorOffset, 0), run.node.data.length);
          }
        }
        return null;
      }
      if (anchor.nodeType === 1) {
        const bp = { node: anchor, offset: Math.min(Math.max(anchorOffset, 0), anchor.childNodes.length) };
        let col = 0;
        for (const run of runs) {
          if (cmpPos(bp, { node: run.node, offset: 0 }) <= 0) break;
          col += run.node.data.length;
        }
        return col;
      }
      return null;
    };
    const boundaryAt = (row, runs, col) => {
      if (runs.length === 0) return { node: row, offset: 0 };
      if (col <= 0) return { node: runs[0].node, offset: 0 };
      const total = runs[runs.length - 1].end;
      if (col >= total) {
        const last = runs[runs.length - 1];
        return { node: last.node, offset: last.node.data.length };
      }
      for (const run of runs) {
        if (col < run.end) return { node: run.node, offset: col - run.start };
      }
      return { node: row, offset: 0 };
    };
    const applyCaretSet = (req) => {
      const fail = (error, extra) => replyAction(req.requestId, "caret_set", { ok: false, error, ...extra ?? {} });
      if (typeof req.selector !== "string" || !req.selector) return fail('Need "selector" parameter (a string)');
      if (typeof req.text !== "string" || !req.text) return fail('Need "text" parameter (a non-empty string)');
      const occurrence = req.occurrence === void 0 ? 1 : req.occurrence;
      if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 1) {
        return fail(`"occurrence" must be a positive integer (got ${JSON.stringify(req.occurrence)})`);
      }
      let position = "after";
      if (req.position !== void 0) {
        if (typeof req.position !== "string" || POSITIONS.indexOf(req.position) < 0) {
          return fail(`Invalid position: ${JSON.stringify(req.position)} (expected before|after|start|end)`);
        }
        position = req.position;
      }
      const root = resolveRoot(req.selector);
      if (!root) return fail(`Element not found: ${req.selector}`, { notFound: true });
      if (!root.isContentEditable) {
        return fail(`Element is not contenteditable: ${req.selector} (tag=${root.tagName.toLowerCase()})`);
      }
      try {
        root.focus();
      } catch {
      }
      try {
        const model = modelOf(root);
        const { found, seen } = findText(model, req.text, occurrence);
        if (!found) {
          if (seen === 0) return fail(`Text not found in editor: "${req.text}"`);
          return fail(`"${req.text}" appears ${seen} time(s) in the editor; occurrence ${occurrence} does not exist (occurrence starts at 1)`);
        }
        const rowModel = model[found.rowIndex];
        const col = position === "start" ? 0 : position === "end" ? rowLen(rowModel) : position === "before" ? found.colStart : found.colEnd;
        const boundary = boundaryAt(rowModel.el, rowModel.runs, col);
        const sel = window.getSelection();
        if (!sel) return fail("Selection API unavailable");
        const range = document.createRange();
        range.setStart(boundary.node, boundary.offset);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        replyAction(req.requestId, "caret_set", { ok: true, row: found.rowIndex, col });
      } catch (e) {
        fail(`caret_set failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const applyCaretGet = (req) => {
      const fail = (error, extra) => replyAction(req.requestId, "caret_get", { ok: false, error, ...extra ?? {} });
      const outOfEditor = () => replyAction(req.requestId, "caret_get", { ok: true, inEditor: false, row: null, col: null, text: null });
      if (typeof req.selector !== "string" || !req.selector) return fail('Need "selector" parameter (a string)');
      const root = resolveRoot(req.selector);
      if (!root) return fail(`Element not found: ${req.selector}`, { notFound: true });
      const sel = window.getSelection();
      const anchor = sel ? sel.anchorNode : null;
      const anchorOffset = sel ? sel.anchorOffset : 0;
      if (!anchor || anchor.nodeType !== 3 && anchor.nodeType !== 1 || !root.contains(anchor)) {
        return outOfEditor();
      }
      try {
        const model = modelOf(root);
        const replyInRow = (rowIndex2, m, col) => {
          if (col === null) return outOfEditor();
          replyAction(req.requestId, "caret_get", { ok: true, inEditor: true, row: rowIndex2, col, text: m.text });
        };
        if (model.length === 1 && model[0].el === root) {
          return replyInRow(0, model[0], colAt(model[0].runs, anchor, anchorOffset));
        }
        let node = anchor;
        while (node !== root && node.parentElement && node.parentElement !== root) {
          node = node.parentElement;
        }
        if (node === root) {
          const k = Math.min(Math.max(anchorOffset, 0), root.children.length);
          let qualifiedBefore = 0;
          let res = null;
          for (let ci = 0; ci < root.children.length; ci++) {
            const child = root.children[ci];
            if (ci === k) {
              if (rowQualified(child)) {
                res = { row: qualifiedBefore, col: 0 };
              } else if (qualifiedBefore > 0) {
                const r = qualifiedBefore - 1;
                res = { row: r, col: rowLen(model[r]) };
              } else {
                res = { row: 0, col: 0 };
              }
              break;
            }
            if (rowQualified(child)) qualifiedBefore++;
          }
          if (!res) {
            if (qualifiedBefore > 0) {
              const r = qualifiedBefore - 1;
              res = { row: r, col: rowLen(model[r]) };
            } else {
              res = { row: 0, col: 0 };
            }
          }
          return replyInRow(res.row, model[res.row], res.col);
        }
        const rowIndex = model.findIndex((m) => m.el === node);
        if (rowIndex < 0) return outOfEditor();
        return replyInRow(rowIndex, model[rowIndex], colAt(model[rowIndex].runs, anchor, anchorOffset));
      } catch (e) {
        fail(`caret_get failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const applyRequest = (detail) => {
      const req = detail;
      if (!req || typeof req !== "object" || typeof req.requestId !== "number") return;
      if (reqSeen(req.requestId)) return;
      if (req.action === "paste_dispatch") applyPasteRequest(req);
      else if (req.action === "caret_set") applyCaretSet(req);
      else if (req.action === "caret_get") applyCaretGet(req);
      else replyAction(req.requestId, typeof req.action === "string" ? req.action : "", { ok: false, error: `Unknown action: ${String(req.action)}` });
    };
    document.addEventListener(ACTION_EVT, (ev) => safeRun(() => applyRequest(ev.detail)));
    window.addEventListener("message", (ev) => {
      safeRun(() => {
        const data = ev.data;
        if (!data || typeof data !== "object" || typeof data[MAIN_MSG] !== "string") return;
        if (data[MAIN_MSG] === ACTION_EVT) applyRequest(data.detail);
      });
    });
  })();
})();
