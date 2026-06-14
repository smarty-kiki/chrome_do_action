"use strict";
(() => {
  // src/popup/popup.ts
  var el = (id) => document.getElementById(id);
  var statusDot = el("statusDot");
  var statusText = el("statusText");
  var retryInfo = el("retryInfo");
  var nodeNameInput = el("nodeName");
  var serverUrlInput = el("serverUrl");
  var btnConnect = el("btnConnect");
  var btnDisconnect = el("btnDisconnect");
  var openOptionsLink = el("openOptions");
  var countdownTimer = null;
  async function loadConfig() {
    const result = await chrome.storage.local.get(["nodeName", "serverUrl"]);
    nodeNameInput.value = result.nodeName || "";
    serverUrlInput.value = result.serverUrl || "";
  }
  function updateUI(data) {
    statusDot.className = "dot " + data.status;
    const labels = {
      connected: "\u5DF2\u8FDE\u63A5",
      connecting: "\u8FDE\u63A5\u4E2D\u2026",
      disconnected: "\u672A\u8FDE\u63A5"
    };
    statusText.textContent = labels[data.status] || data.status;
    updateRetryInfo(data);
  }
  function updateRetryInfo(data) {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    retryInfo.textContent = "";
    retryInfo.className = "retry-info";
    const { retry } = data;
    if (data.status === "connecting" && retry) {
      if (retry.retryCount > 0) {
        retryInfo.textContent = `\u6B63\u5728\u8FDE\u63A5 (${retry.retryCount}/${retry.maxRetries})\u2026`;
      } else {
        retryInfo.textContent = `\u6B63\u5728\u8FDE\u63A5\u2026`;
      }
    } else if (data.status === "disconnected" && retry?.nextRetryAt) {
      retryInfo.className = "retry-info";
      retryInfo.style.color = "#999";
      startCountdown(retry);
    } else if (data.status === "disconnected") {
      retryInfo.className = "retry-info";
      retryInfo.textContent = "\u672A\u8FDE\u63A5";
    }
  }
  function startCountdown(retry) {
    const tick = () => {
      const now = Date.now();
      const remaining = Math.max(0, Math.ceil((retry.nextRetryAt - now) / 1e3));
      retryInfo.textContent = `${remaining}\u79D2\u540E\u91CD\u8FDE (\u672C\u8F6E\u7B2C${retry.retryCount}\u6B21\u5931\u8D25)`;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    };
    tick();
    countdownTimer = self.setInterval(tick, 200);
  }
  chrome.runtime.onMessage.addListener(
    (msg) => {
      if (msg.type === "status_update" && msg.status) {
        updateUI({
          status: msg.status,
          retry: msg.retry
        });
      }
    }
  );
  chrome.runtime.sendMessage({ type: "get_status" }, (res) => {
    if (res?.status) {
      updateUI({
        status: res.status,
        retry: res.retry
      });
    }
  });
  btnConnect.addEventListener("click", async () => {
    const nodeName = nodeNameInput.value.trim();
    const serverUrl = serverUrlInput.value.trim();
    if (!nodeName || !serverUrl) {
      alert("\u8BF7\u586B\u5199\u8282\u70B9\u540D\u79F0\u548C\u670D\u52A1\u7AEF\u5730\u5740");
      return;
    }
    await chrome.runtime.sendMessage({ type: "connect", nodeName, serverUrl });
  });
  btnDisconnect.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "disconnect" });
  });
  openOptionsLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  loadConfig();
})();
