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
})();
