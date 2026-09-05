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
    const pointerGuard = (ev) => {
      if (interceptState.picking) {
        if (hitsHost(ev)) {
          ev.stopImmediatePropagation();
          return;
        }
        ev.stopImmediatePropagation();
        ev.preventDefault();
        return;
      }
      if (interceptState.iso && hitsHost(ev)) {
        ev.stopImmediatePropagation();
      }
    };
    for (const type of POINTER_TYPES) {
      window.addEventListener(type, (ev) => safeRun(() => pointerGuard(ev)), true);
    }
    const keyGuard = (ev) => {
      if (interceptState.picking) {
        if (ev.key === "Escape" && !ev.repeat) {
          ev.stopImmediatePropagation();
          ev.preventDefault();
        }
        return;
      }
      if (interceptState.iso && hitsHost(ev) && (ev.key === "Escape" || ev.key.length === 1 || ev.key === "Backspace" || ev.key === "Tab")) {
        ev.stopImmediatePropagation();
      }
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
})();
