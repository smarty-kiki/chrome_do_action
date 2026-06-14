import type { WsClient, ConnectionStatus } from "../ws/client";

const el = (id: string) => document.getElementById(id)!;

const nodeNameInput = el("nodeName") as HTMLInputElement;
const serverUrlInput = el("serverUrl") as HTMLInputElement;
const toggle = el("autoConnectToggle");
const btnConnect = el("btnConnect")!;
const btnDisconnect = el("btnDisconnect")!;
const retryBox = el("retryBox");
const retryLine = el("retryLine");

let autoConnect = true;
let countdownTimer: number | null = null;

async function init() {
  const result = (await chrome.storage.local.get(["nodeName", "serverUrl", "autoConnect"])) as {
    nodeName?: string;
    serverUrl?: string;
    autoConnect?: boolean;
  };
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
    autoConnect,
  });
});

btnConnect.addEventListener("click", async () => {
  const nodeName = nodeNameInput.value.trim();
  const serverUrl = serverUrlInput.value.trim();
  if (!nodeName || !serverUrl) {
    retryBox.style.display = "block";
    retryLine.className = "retry-line error";
    retryLine.textContent = "请先填写节点名称和服务端地址";
    return;
  }
  await chrome.runtime.sendMessage({ type: "connect", nodeName, serverUrl });
});

btnDisconnect.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
});

chrome.runtime.onMessage.addListener(
  (msg: { type: string; status?: string; retry?: unknown }) => {
    if (msg.type === "status_update" && msg.status) {
      updateRetryUI(msg.status, msg.retry as RetryState | undefined);
    }
  },
);

chrome.runtime.sendMessage({ type: "get_status" }, (res: { status?: string; retry?: unknown } | undefined) => {
  if (res?.status) {
    updateRetryUI(res.status, res.retry as RetryState | undefined);
  }
});

type RetryState = { retryCount: number; maxRetries: number; nextRetryAt: number | null; retryIntervalMs: number };

function updateRetryUI(status: string, retry?: RetryState) {
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
      retryLine.textContent = `正在连接 (${count}/${max})…`;
    } else {
      retryLine.textContent = `正在连接…`;
    }
  } else if (status === "connected") {
    retryLine.className = "retry-line success";
    retryLine.textContent = "已连接到服务端";
  } else if (status === "disconnected") {
    if (retry?.nextRetryAt) {
      retryLine.className = "retry-line countdown";
      startCountdown(retry);
    } else {
      retryLine.className = "retry-line";
      retryLine.textContent = "未连接";
    }
  } else if (status === "error") {
    retryLine.className = "retry-line error";
    retryLine.textContent = "连接错误";
  } else {
    retryBox.style.display = "none";
  }
}

function startCountdown(retry: RetryState) {
  const tick = () => {
    const now = Date.now();
    const remaining = Math.max(0, Math.ceil((retry.nextRetryAt! - now) / 1000));
    retryLine.textContent = `${remaining}秒后重连 (本轮第${retry.retryCount}次失败)`;
    if (remaining <= 0) {
      clearInterval(countdownTimer!);
      countdownTimer = null;
    }
  };
  tick();
  countdownTimer = self.setInterval(tick, 200) as unknown as number;
}

init();
