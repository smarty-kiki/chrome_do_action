import type { WsClient, ConnectionStatus } from "../ws/client";

const el = (id: string) => document.getElementById(id)!;

const statusDot = el("statusDot");
const statusText = el("statusText");
const retryInfo = el("retryInfo");
const nodeNameInput = el("nodeName") as HTMLInputElement;
const serverUrlInput = el("serverUrl") as HTMLInputElement;
const btnConnect = el("btnConnect");
const btnDisconnect = el("btnDisconnect");
const openOptionsLink = el("openOptions");

let countdownTimer: number | null = null;

async function loadConfig() {
  const result = (await chrome.storage.local.get(["nodeName", "serverUrl"])) as {
    nodeName?: string;
    serverUrl?: string;
  };
  nodeNameInput.value = result.nodeName || "";
  serverUrlInput.value = result.serverUrl || "";
}

function updateUI(data: { status: string; retry?: { retryCount: number; maxRetries: number; nextRetryAt: number | null; retryIntervalMs: number } }) {
  statusDot.className = "dot " + data.status;
  const labels: Record<string, string> = {
    connected: "已连接",
    connecting: "连接中…",
    disconnected: "未连接",
  };
  statusText.textContent = labels[data.status] || data.status;
  updateRetryInfo(data);
}

function updateRetryInfo(data: { status: string; retry?: { retryCount: number; maxRetries: number; nextRetryAt: number | null; retryIntervalMs: number } }) {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  retryInfo.textContent = "";
  retryInfo.className = "retry-info";

  const { retry } = data;

  if (data.status === "connecting" && retry) {
    if (retry.retryCount > 0) {
      retryInfo.textContent = `正在连接 (${retry.retryCount}/${retry.maxRetries})…`;
    } else {
      retryInfo.textContent = `正在连接…`;
    }
  } else if (data.status === "disconnected" && retry?.nextRetryAt) {
    retryInfo.className = "retry-info";
    retryInfo.style.color = "#999";
    startCountdown(retry);
  } else if (data.status === "disconnected") {
    retryInfo.className = "retry-info";
    retryInfo.textContent = "未连接";
  }
}

function startCountdown(retry: { retryCount: number; maxRetries: number; nextRetryAt: number; retryIntervalMs: number }) {
  const tick = () => {
    const now = Date.now();
    const remaining = Math.max(0, Math.ceil((retry.nextRetryAt - now) / 1000));
    retryInfo.textContent = `${remaining}秒后重连 (本轮第${retry.retryCount}次失败)`;
    if (remaining <= 0) {
      clearInterval(countdownTimer!);
      countdownTimer = null;
    }
  };
  tick();
  countdownTimer = self.setInterval(tick, 200) as unknown as number;
}

chrome.runtime.onMessage.addListener(
  (msg: { type: string; status?: string; retry?: unknown }) => {
    if (msg.type === "status_update" && msg.status) {
      updateUI({
        status: msg.status,
        retry: msg.retry as { retryCount: number; maxRetries: number; nextRetryAt: number | null; retryIntervalMs: number } | undefined,
      });
    }
  },
);

chrome.runtime.sendMessage({ type: "get_status" }, (res: { status?: string; retry?: unknown } | undefined) => {
  if (res?.status) {
    updateUI({
      status: res.status,
      retry: res.retry as { retryCount: number; maxRetries: number; nextRetryAt: number | null; retryIntervalMs: number } | undefined,
    });
  }
});

btnConnect.addEventListener("click", async () => {
  const nodeName = nodeNameInput.value.trim();
  const serverUrl = serverUrlInput.value.trim();
  if (!nodeName || !serverUrl) {
    alert("请填写节点名称和服务端地址");
    return;
  }
  await chrome.runtime.sendMessage({ type: "connect", nodeName, serverUrl });
});

btnDisconnect.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnect" });
});

openOptionsLink.addEventListener("click", (e: Event) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

loadConfig();
