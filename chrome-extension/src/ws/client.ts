import type { Message, MessageType } from "./types";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type StatusListener = (status: ConnectionStatus) => void;

export interface ReconnectOptions {
  maxRetries: number;
  retryIntervalMs: number;
}

const DEFAULT_OPTIONS: ReconnectOptions = {
  maxRetries: 3,
  retryIntervalMs: 15000,
};

export interface RetryState {
  retryCount: number;
  maxRetries: number;
  retryIntervalMs: number;
  nextRetryAt: number | null;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private listeners: StatusListener[] = [];
  private messageHandlers: Map<MessageType, Set<(msg: Message) => void>> = new Map();
  private retryCount = 0;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private reconnectOptions: ReconnectOptions;
  private serverUrl: string = "";
  private nodeName: string = "";
  private nextRetryAt: number | null = null;
  private connecting = false;

  constructor(options?: Partial<ReconnectOptions>) {
    this.reconnectOptions = { ...DEFAULT_OPTIONS, ...options };
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getRetryState(): RetryState {
    return {
      retryCount: this.retryCount,
      maxRetries: this.reconnectOptions.maxRetries,
      retryIntervalMs: this.reconnectOptions.retryIntervalMs,
      nextRetryAt: this.nextRetryAt,
    };
  }

  connect(serverUrl: string, nodeName: string): void {
    this.serverUrl = serverUrl;
    this.nodeName = nodeName;
    if (this.status === "connected" || this.connecting) {
      return;
    }
    this.cancelRetry();
    this.connecting = true;
    this.retryCount = 0;
    this.setStatus("connecting");
    this.doConnect();
  }

  disconnect(): void {
    this.cancelRetry();
    this.cancelPing();
    this.connecting = false;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  send(msg: Message): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(type: MessageType, handler: (msg: Message) => void): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);
    return () => this.messageHandlers.get(type)?.delete(handler);
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.push(listener);
    listener(this.status);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private doConnect(): void {
    if (!this.isValidUrl(this.serverUrl)) {
      this.onConnectFailed();
      return;
    }
    try {
      const ws = new WebSocket(this.serverUrl);
      this.ws = ws;

      ws.onopen = () => {
        this.retryCount = 0;
        this.connecting = false;
        this.setStatus("connected");
        this.send({
          type: "register",
          id: this.genId(),
          payload: { nodeName: this.nodeName },
        });
        this.startPing();
      };

      ws.onmessage = (event: MessageEvent) => {
        let msg: Message;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        this.dispatch(msg);
      };

      ws.onerror = (e: Event) => {
        e.preventDefault();
      };

      ws.onclose = () => {
        this.cancelPing();
        this.ws = null;
        this.onConnectFailed();
      };
    } catch {
      this.onConnectFailed();
    }
  }

  private onConnectFailed(): void {
    this.cancelPing();
    this.ws = null;
    this.retryCount++;

    if (this.retryCount >= this.reconnectOptions.maxRetries) {
      // 本轮 N 次用完，等待一轮后重新开始
      this.connecting = false;
      this.nextRetryAt = Date.now() + this.reconnectOptions.retryIntervalMs;
      this.setStatus("disconnected");
      this.retryTimer = self.setTimeout(() => {
        this.retryCount = 0;
        this.connecting = true;
        this.nextRetryAt = null;
        this.setStatus("connecting");
        this.doConnect();
      }, this.reconnectOptions.retryIntervalMs) as unknown as number;
    } else {
      // 本轮还有余量，立即再试
      this.retryTimer = self.setTimeout(() => {
        this.doConnect();
      }, 0) as unknown as number;
      // 状态虽未变，但 retryCount 变了，通知监听器更新 UI
      this.listeners.forEach((l) => l(this.status));
    }
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      self.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.nextRetryAt = null;
  }

  private startPing(): void {
    this.cancelPing();
    this.pingTimer = self.setInterval(() => {
      this.send({ type: "ping", id: this.genId(), payload: { timestamp: Date.now() } });
    }, 30000) as unknown as number;
  }

  private cancelPing(): void {
    if (this.pingTimer !== null) {
      self.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private dispatch(msg: Message): void {
    if (msg.type === "pong") return;
    const handlers = this.messageHandlers.get(msg.type);
    if (handlers) {
      handlers.forEach((h) => h(msg));
    }
    const wildcard = this.messageHandlers.get("*" as MessageType);
    if (wildcard) {
      wildcard.forEach((h) => h(msg));
    }
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.listeners.forEach((l) => l(s));
  }

  private genId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  private isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "ws:" || parsed.protocol === "wss:";
    } catch {
      return false;
    }
  }
}
