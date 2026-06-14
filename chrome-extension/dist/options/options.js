"use strict";
(() => {
  // src/options/options.ts
  var el = (id) => document.getElementById(id);
  var nodeNameInput = el("nodeName");
  var serverUrlInput = el("serverUrl");
  var toggle = el("autoConnectToggle");
  var btnConnect = el("btnConnect");
  var btnDisconnect = el("btnDisconnect");
  var retryBox = el("retryBox");
  var retryLine = el("retryLine");
  var autoConnect = true;
  var countdownTimer = null;
  async function init() {
    const result = await chrome.storage.local.get(["nodeName", "serverUrl", "autoConnect"]);
    nodeNameInput.value = result.nodeName || "";
    serverUrlInput.value = result.serverUrl || "";
    autoConnect = result.autoConnect ?? true;
    updateToggleUI();
  }
  function updateToggleUI() {
    toggle.className = "toggle" + (autoConnect ? " on" : "");
  }
  toggle.addEventListener("click", () => {
    autoConnect = !autoConnect;
    updateToggleUI();
  });
  el("btnSave").addEventListener("click", async () => {
    await chrome.storage.local.set({
      nodeName: nodeNameInput.value.trim(),
      serverUrl: serverUrlInput.value.trim(),
      autoConnect
    });
  });
  btnConnect.addEventListener("click", async () => {
    const nodeName = nodeNameInput.value.trim();
    const serverUrl = serverUrlInput.value.trim();
    if (!nodeName || !serverUrl) {
      retryBox.style.display = "block";
      retryLine.className = "retry-line error";
      retryLine.textContent = "\u8BF7\u5148\u586B\u5199\u8282\u70B9\u540D\u79F0\u548C\u670D\u52A1\u7AEF\u5730\u5740";
      return;
    }
    await chrome.runtime.sendMessage({ type: "connect", nodeName, serverUrl });
  });
  btnDisconnect.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "disconnect" });
  });
  chrome.runtime.onMessage.addListener(
    (msg) => {
      if (msg.type === "status_update" && msg.status) {
        updateRetryUI(msg.status, msg.retry);
      }
    }
  );
  chrome.runtime.sendMessage({ type: "get_status" }, (res) => {
    if (res?.status) {
      updateRetryUI(res.status, res.retry);
    }
  });
  function updateRetryUI(status, retry) {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    retryBox.style.display = "block";
    if (status === "connecting") {
      retryLine.className = "retry-line connecting";
      const count = retry?.retryCount ?? 0;
      const max = retry?.maxRetries ?? 3;
      if (count > 0) {
        retryLine.textContent = `\u6B63\u5728\u8FDE\u63A5 (${count}/${max})\u2026`;
      } else {
        retryLine.textContent = `\u6B63\u5728\u8FDE\u63A5\u2026`;
      }
    } else if (status === "connected") {
      retryLine.className = "retry-line success";
      retryLine.textContent = "\u5DF2\u8FDE\u63A5\u5230\u670D\u52A1\u7AEF";
    } else if (status === "disconnected") {
      if (retry?.nextRetryAt) {
        retryLine.className = "retry-line countdown";
        startCountdown(retry);
      } else {
        retryLine.className = "retry-line";
        retryLine.textContent = "\u672A\u8FDE\u63A5";
      }
    } else if (status === "error") {
      retryLine.className = "retry-line error";
      retryLine.textContent = "\u8FDE\u63A5\u9519\u8BEF";
    } else {
      retryBox.style.display = "none";
    }
  }
  function startCountdown(retry) {
    const tick = () => {
      const now = Date.now();
      const remaining = Math.max(0, Math.ceil((retry.nextRetryAt - now) / 1e3));
      retryLine.textContent = `${remaining}\u79D2\u540E\u91CD\u8FDE (\u672C\u8F6E\u7B2C${retry.retryCount}\u6B21\u5931\u8D25)`;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    };
    tick();
    countdownTimer = self.setInterval(tick, 200);
  }
  init();
})();
